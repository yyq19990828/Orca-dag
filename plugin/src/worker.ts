// Orchestration Panel trusted-worker entry (M1 + M2 companion bridge).
//
// Responsibilities:
// 1. Discover local Orca DAG viewers through the user-private trust registry.
// 2. Forward live `agent.status.changed`, `agent.tool.after` (observe-only),
//    and `agent.prompt.before` (observe-only) events to the matching viewer so
//    its centralized OutputTail wakes immediately and renders local tool calls.
// 3. Long-poll the viewer's `/api/plugin/inbox` to update Orca's status bar,
//    deliver gate/failure notifications, and execute approved host commands
//    (such as `agent.resume` in M3).
// 4. Report connection status without exposing privileged host diagnostics.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { OrcaWorkerApi } from 'orca/worker'
import { pluginRequestToken, readPluginEndpointFile, signPluginReply, type PluginEndpointRecord } from './endpoint'
import type {
  ActivitySubscribeRequest,
  BridgeApiRequest,
  BridgeApiResponse,
  OutputSubscribeRequest,
  ProbeRequest,
  SkillInstallReply,
  StreamSubscription,
} from './protocol'

const PLUGIN_ID = 'orchestration-panel'
const PLUGIN_VERSION = '0.1.0'
const MAX_STATUS_EVENTS = 50
const DISCOVERY_INTERVAL_MS = 10_000
const FLUSH_DEBOUNCE_MS = 100
const INBOX_WAIT_MS = 10_000
/** Orca caps panels.post at 256 KiB; stay comfortably below it. */
const MAX_PANEL_POST_BYTES = 220 * 1024
const MANAGED_START_TIMEOUT_MS = 8_000
const MANAGED_POLL_INTERVAL_MS = 80
const execFileAsync = promisify(execFile)

type SkillUninstallReply =
  | { ok: true; removed: number; failed: number }
  | { ok: false; code: 'bundle_unavailable' | 'uninstall_failed' }

interface BundledAssets {
  serverEntry: string
  panelDir: string | null
}

function resolveBundledAssets(): BundledAssets | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const root of [here, dirname(here)]) {
      const serverEntry = join(root, 'server', 'index.mjs')
      if (existsSync(serverEntry)) {
        const panelDir = join(root, 'panel')
        return {
          serverEntry,
          panelDir: existsSync(join(panelDir, 'index.html')) ? panelDir : null,
        }
      }
    }
  } catch {
    // Non-file URL or test environment without bundled server.
  }
  return null
}

interface ManagedServerEntry {
  child: ChildProcess
  workspacePath: string
  startedAt: number
  exited: boolean
  lastStderr: string
}

function buildManagedServerEnv(workspacePath: string, panelDir: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (
      key === 'PORT' ||
      key === 'ORCA_DAG_WEB_URL' ||
      key === 'ORCA_DAG_WEB_DIR' ||
      key === 'ORCA_WORKTREE' ||
      key === 'ORCA_ENVIRONMENT' ||
      key === 'ORCA_PAIRING_CODE' ||
      key === 'ORCA_TERMINAL_HANDLE' ||
      key === 'ORCA_PANE_KEY' ||
      key === 'ORCA_TAB_ID' ||
      key === 'ORCA_AGENT_PANE' ||
      key.startsWith('ORCA_AGENT_LAUNCH') ||
      key.startsWith('ORCA_AGENT_HOOK_') ||
      key === 'ORCA_OPENCODE_AGENT'
    ) {
      delete env[key]
    }
  }
  env.WORKSPACE_DIR = workspacePath
  env.PORT = '0'
  env.NO_OPEN = '1'
  env.ORCA_DAG_NO_SKILL = '1'
  env.ORCA_DAG_NO_WORKSPACE_INIT = '1'
  if (panelDir) env.ORCA_DAG_WEB_DIR = panelDir
  return env
}

function panelApiPath(url: string): boolean {
  if (!url.startsWith('/api/') || /[\s\\#\u0000-\u001f\u007f]/.test(url)) return false
  const pathname = url.split('?', 1)[0]
  try {
    const segments = pathname.slice(5).split('/').map(decodeURIComponent)
    return segments.every((segment) => segment && segment !== '.' && segment !== '..' && !/[\s/\\%?#\u0000-\u001f\u007f]/.test(segment)) &&
      segments[0].toLowerCase() !== 'plugin' &&
      segments.at(-1)?.toLowerCase() !== 'stream'
  } catch {
    return false
  }
}

async function verifiedPluginReply(
  res: Response, key: string, kind: 'hello' | 'inbox', nonce: string,
): Promise<unknown> {
  const proof = res.headers.get('x-orca-plugin-proof')
  if (!res.ok || !proof || !/^[A-Za-z0-9_-]{43}$/.test(proof)) {
    await res.body?.cancel()
    throw new Error('Viewer did not provide an authenticated reply')
  }
  const body = await res.text()
  if (!timingSafeEqual(Buffer.from(proof), Buffer.from(signPluginReply(key, kind, nonce, body)))) {
    throw new Error('Viewer reply did not match this connection')
  }
  return JSON.parse(body) as unknown
}

interface ViewerConnection {
  workspacePath: string
  workspaceListId: string | null
  endpoint: PluginEndpointRecord
  requestToken: string
  abort: AbortController
  connected: boolean
  lastSyncAt: number
  mutationToken: string | null
  queuedStatus: Array<Record<string, unknown>>
  queuedTools: Array<Record<string, unknown>>
  queuedPrompts: Array<Record<string, unknown>>
  flushTimer: ReturnType<typeof setTimeout> | null
}

interface RingState {
  activatedAt: number
  statusCount: number
  toolCount: number
  promptCount: number
  workspaceCount: number
  forwardedBatches: number
  recentStatus: Array<Record<string, unknown>>
}

let activeShutdown: (() => void) | null = null

function pushRing<T>(buf: T[], item: T, max: number): void {
  buf.push(item)
  if (buf.length > max) buf.splice(0, buf.length - max)
}

export default function activate(orca: OrcaWorkerApi): void {
  activeShutdown?.()

  let disposed = false
  const connections = new Map<string, ViewerConnection>()
  const managedServers = new Map<string, ManagedServerEntry>()
  const startingServers = new Map<string, Promise<ViewerConnection | null>>()
  const activityStreams = new Map<string, AbortController>()
  const outputStreams = new Map<string, AbortController>()
  let focusedWorkspaceId: string | null = null
  const bundledAssets = resolveBundledAssets()
  let skillInstall: Promise<SkillInstallReply> | undefined
  let skillUninstall: Promise<SkillUninstallReply> | undefined

  const state: RingState = {
    activatedAt: Date.now(),
    statusCount: 0,
    toolCount: 0,
    promptCount: 0,
    workspaceCount: 0,
    forwardedBatches: 0,
    recentStatus: [],
  }

  let toolStreamEnabled = true
  let notifyEnabled = true

  async function loadSettings(): Promise<void> {
    if (!orca.host.has('settings.get')) return
    try {
      const { settings } = await orca.host.call('settings.get', {})
      if (typeof settings.toolStream === 'boolean') toolStreamEnabled = settings.toolStream
      if (typeof settings.notify === 'boolean') notifyEnabled = settings.notify
    } catch {
      // Keep defaults when settings cannot be read.
    }
  }

  function updateStatusBar(summary: {
    text: string
    tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
    tooltip?: string
  }): void {
    if (disposed || !orca.host.has('statusBar.update')) return
    void orca.host
      .call('statusBar.update', {
        id: 'run',
        text: summary.text,
        tone: summary.tone ?? 'neutral',
        tooltip: summary.tooltip ?? 'Orchestration Panel companion plugin',
        visible: true,
      })
      .catch(() => {})
  }

  function viewerHeaders(conn: ViewerConnection): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-orca-plugin-token': conn.requestToken,
    }
  }

  function disconnectViewer(key: string): void {
    const conn = connections.get(key)
    if (!conn) return
    connections.delete(key)
    conn.connected = false
    if (conn.flushTimer) clearTimeout(conn.flushTimer)
    conn.abort.abort()
    if (connections.size === 0) {
      updateStatusBar({
        text: 'Orchestration',
        tone: 'neutral',
        tooltip: 'Orchestration Panel (no local viewer connected)',
      })
    }
  }

  async function postJson(
    conn: ViewerConnection,
    path: string,
    body: Record<string, unknown>,
    timeoutMs = 3000,
  ): Promise<boolean> {
    if (conn.abort.signal.aborted) return false
    const controller = new AbortController()
    const onParentAbort = () => controller.abort()
    conn.abort.signal.addEventListener('abort', onParentAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const res = await fetch(`http://127.0.0.1:${conn.endpoint.port}${path}`, {
        method: 'POST',
        headers: viewerHeaders(conn),
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      })
      await res.body?.cancel()
      return res.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
      conn.abort.signal.removeEventListener('abort', onParentAbort)
    }
  }

  async function flushViewer(conn: ViewerConnection): Promise<void> {
    conn.flushTimer = null
    if (disposed || !conn.connected) return
    const statusEvents = conn.queuedStatus.splice(0)
    const toolEvents = conn.queuedTools.splice(0)
    const promptEvents = conn.queuedPrompts.splice(0)
    if (statusEvents.length === 0 && toolEvents.length === 0 && promptEvents.length === 0) return
    const ok = await postJson(conn, '/api/plugin/events', { statusEvents, toolEvents, promptEvents })
    if (ok) {
      conn.lastSyncAt = Date.now()
      state.forwardedBatches += 1
    } else if (conn.connected) {
      disconnectViewer(conn.workspacePath)
    }
  }

  function scheduleFlush(conn: ViewerConnection): void {
    if (conn.flushTimer || !conn.connected || disposed) return
    conn.flushTimer = setTimeout(() => {
      void flushViewer(conn)
    }, FLUSH_DEBOUNCE_MS)
    conn.flushTimer.unref?.()
  }

  function matchingConnections(workspaceId: string | null, workspaceListId?: string | null): ViewerConnection[] {
    return [...connections.values()].filter((conn) => conn.connected && (
      workspaceListId
        ? conn.workspaceListId === workspaceListId
        : workspaceId !== null && (workspaceId === conn.workspaceListId || workspaceId === conn.workspacePath)
    ))
  }

  async function executeInboxCommand(
    conn: ViewerConnection,
    cmd: { id: string; kind: string; params?: Record<string, unknown> },
  ): Promise<void> {
    if (!conn.connected || conn.abort.signal.aborted) return
    const params = cmd.params ?? {}
    let receipt: Record<string, unknown>
    try {
      if (cmd.kind === 'agent.resume') {
        if (!orca.host.has('agent.resume')) {
          receipt = { ok: false, code: 'unsupported', error: 'agent.resume unavailable on this Orca host' }
        } else {
          const res = await orca.host.call('agent.resume', {
            workspaceId: String(params.workspaceId ?? ''),
            agent: String(params.agent ?? '') as Parameters<typeof orca.host.call<'agent.resume'>>[1]['agent'],
            sessionId: String(params.sessionId ?? ''),
          })
          receipt = { ok: true, ...res }
        }
      } else if (cmd.kind === 'agent.listSessions') {
        if (!orca.host.has('agent.listSessions')) {
          receipt = { ok: false, code: 'unsupported', error: 'agent.listSessions unavailable' }
        } else {
          const req: { workspaceId?: string; limit?: number } = {}
          if (typeof params.workspaceId === 'string') req.workspaceId = params.workspaceId
          if (typeof params.limit === 'number') req.limit = params.limit
          receipt = { ok: true, ...(await orca.host.call('agent.listSessions', req)) }
        }
      } else if (cmd.kind === 'workspace.list') {
        if (!orca.host.has('workspace.list')) {
          receipt = { ok: false, code: 'unsupported', error: 'workspace.list unavailable' }
        } else {
          const req = params.includeStatus === true ? { includeStatus: true } : {}
          receipt = { ok: true, ...(await orca.host.call('workspace.list', req)) }
        }
      } else {
        receipt = { ok: false, code: 'unknown_command', error: `Unsupported command ${cmd.kind}` }
      }
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown }
      receipt = {
        ok: false,
        code: typeof e?.code === 'string' ? e.code : 'action_failed',
        error: String(e?.message ?? err),
      }
    }
    await postJson(conn, `/api/plugin/receipts/${encodeURIComponent(cmd.id)}`, receipt)
  }

  async function runInboxLoop(conn: ViewerConnection): Promise<void> {
    while (!disposed && conn.connected && !conn.abort.signal.aborted) {
      try {
        const nonce = randomBytes(16).toString('base64url')
        const res = await fetch(`http://127.0.0.1:${conn.endpoint.port}/api/plugin/inbox?waitMs=${INBOX_WAIT_MS}`, {
          headers: { 'x-orca-plugin-token': conn.requestToken, 'x-orca-plugin-nonce': nonce },
          redirect: 'error',
          signal: AbortSignal.any([conn.abort.signal, AbortSignal.timeout(INBOX_WAIT_MS + 5_000)]),
        })
        const data = await verifiedPluginReply(res, conn.endpoint.pluginToken, 'inbox', nonce) as {
          commands?: Array<{ id: string; kind: string; params?: Record<string, unknown> }>
          notifications?: Array<{ id: string; title: string; body?: string }>
          statusBar?: { text: string; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; tooltip?: string } | null
        }
        if (conn.abort.signal.aborted) return
        conn.lastSyncAt = Date.now()
        if (data.statusBar) {
          updateStatusBar(data.statusBar)
        }
        if (notifyEnabled && Array.isArray(data.notifications) && orca.host.has('notifications.show')) {
          for (const note of data.notifications) {
            void orca.host.call('notifications.show', { title: note.title, body: note.body }).catch(() => {})
          }
        }
        if (Array.isArray(data.commands)) {
          for (const cmd of data.commands) {
            void executeInboxCommand(conn, cmd)
          }
        }
      } catch {
        if (!disposed && conn.connected) disconnectViewer(conn.workspacePath)
        return
      }
    }
  }

  async function connectViewer(workspacePath: string, workspaceListId: string | null, endpoint: PluginEndpointRecord): Promise<void> {
    const existing = connections.get(workspacePath)
    if (
      existing &&
      existing.connected &&
      existing.endpoint.instanceId === endpoint.instanceId &&
      existing.endpoint.port === endpoint.port &&
      existing.endpoint.pluginToken === endpoint.pluginToken
    ) {
      existing.workspaceListId = workspaceListId ?? existing.workspaceListId
      return
    }
    if (existing) disconnectViewer(workspacePath)

    const conn: ViewerConnection = {
      workspacePath,
      workspaceListId,
      endpoint,
      requestToken: pluginRequestToken(endpoint.pluginToken),
      abort: new AbortController(),
      connected: false,
      lastSyncAt: 0,
      mutationToken: null,
      queuedStatus: [],
      queuedTools: [],
      queuedPrompts: [],
      flushTimer: null,
    }
    connections.set(workspacePath, conn)

    try {
      const nonce = randomBytes(16).toString('base64url')
      const res = await fetch(`http://127.0.0.1:${endpoint.port}/api/plugin/hello`, {
        method: 'POST',
        headers: { ...viewerHeaders(conn), 'x-orca-plugin-nonce': nonce },
        body: JSON.stringify({
          pluginId: PLUGIN_ID,
          version: PLUGIN_VERSION,
          hostApiMinor: orca.api.minor,
          grantedCapabilities: [...orca.grantedCapabilities],
        }),
        redirect: 'error',
        signal: AbortSignal.any([conn.abort.signal, AbortSignal.timeout(3_000)]),
      })
      const reply = await verifiedPluginReply(res, endpoint.pluginToken, 'hello', nonce) as { ok?: boolean; workspaceDir?: string }
      if (reply?.ok !== true || reply.workspaceDir !== endpoint.workspace) throw new Error('Viewer workspace mismatch')
    } catch {
      if (connections.get(workspacePath) === conn) disconnectViewer(workspacePath)
      return
    }
    if (disposed || conn.abort.signal.aborted) return
    conn.connected = true
    conn.lastSyncAt = Date.now()
    orca.log(`connected to viewer at 127.0.0.1:${endpoint.port} (${workspacePath})`)
    void runInboxLoop(conn)
  }

  let discoveryPromise: Promise<void> | null = null
  async function discoverViewers(): Promise<void> {
    if (disposed || !orca.host.has('workspace.list')) return
    if (discoveryPromise) return await discoveryPromise
    discoveryPromise = (async () => {
      try {
        const { workspaces } = await orca.host.call('workspace.list', {})
        const seenPaths = new Set<string>()
        for (const ws of workspaces) {
          if (disposed) return
          if (ws.hostId !== 'local' && ws.hostId !== null) continue
          if (!ws.path) continue
          seenPaths.add(ws.path)
          const endpoint = readPluginEndpointFile(ws.path)
          if (endpoint) {
            await connectViewer(ws.path, ws.id, endpoint)
          } else if (connections.has(ws.path)) {
            disconnectViewer(ws.path)
          }
        }
        for (const path of [...connections.keys()]) {
          if (!seenPaths.has(path)) disconnectViewer(path)
        }
      } catch {
        // Host unavailable or mock host without workspaces.
      }
    })().finally(() => {
      discoveryPromise = null
    })
    return await discoveryPromise
  }

  void loadSettings()
  orca.settings.onDidChange(() => {
    void loadSettings()
  })

  updateStatusBar({
    text: 'Orchestration',
    tone: 'neutral',
    tooltip: 'Orchestration Panel companion plugin ready',
  })

  const discoveryTimer = setInterval(() => {
    void discoverViewers()
  }, DISCOVERY_INTERVAL_MS)
  discoveryTimer.unref?.()
  void discoverViewers()

  // --- Events & observe-only hooks ---
  orca.events.on('agent.status.changed', (payload) => {
    state.statusCount += 1
    const item = {
      workspaceId: payload.workspaceId,
      workspaceListId: payload.workspaceListId ?? null,
      terminalId: payload.terminalId ?? null,
    }
    pushRing(state.recentStatus, item, MAX_STATUS_EVENTS)
    for (const conn of matchingConnections(payload.workspaceId, payload.workspaceListId ?? null)) {
      if (item.terminalId) pushRing(conn.queuedStatus, { terminalId: item.terminalId }, MAX_STATUS_EVENTS)
      scheduleFlush(conn)
    }
  })

  orca.events.on('workspace.changed', (payload) => {
    state.workspaceCount += 1
    focusedWorkspaceId = payload.context?.workspaceId ?? null
    void discoverViewers()
  })

  function stopManagedServer(workspacePath: string): void {
    const entry = managedServers.get(workspacePath)
    if (!entry) return
    managedServers.delete(workspacePath)
    if (!entry.exited && entry.child.pid) {
      try {
        entry.child.kill('SIGTERM')
      } catch {
        // Already exited.
      }
    }
  }

  async function ensureManagedViewer(
    workspacePath: string,
    workspaceListId: string | null,
  ): Promise<ViewerConnection | null> {
    if (disposed || !bundledAssets) return null
    const already = connections.get(workspacePath)
    if (already?.connected) return already

    // Check once more if an external viewer is already live on disk.
    const existingEp = readPluginEndpointFile(workspacePath)
    if (existingEp) {
      await connectViewer(workspacePath, workspaceListId, existingEp)
      const connected = connections.get(workspacePath)
      if (connected?.connected) return connected
    }

    const inFlight = startingServers.get(workspacePath)
    if (inFlight) return await inFlight

    const promise = (async (): Promise<ViewerConnection | null> => {
      if (disposed) return null
      // Clean up any stale exited child reference first.
      const prev = managedServers.get(workspacePath)
      if (prev && !prev.exited) {
        stopManagedServer(workspacePath)
      }

      orca.log(`starting embedded viewer server for ${workspacePath}`)
      const child = spawn(process.execPath, [bundledAssets.serverEntry], {
        cwd: workspacePath,
        env: buildManagedServerEnv(workspacePath, bundledAssets.panelDir),
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      const entry: ManagedServerEntry = {
        child,
        workspacePath,
        startedAt: Date.now(),
        exited: false,
        lastStderr: '',
      }
      managedServers.set(workspacePath, entry)
      child.stderr?.on('data', (chunk: Buffer) => {
        entry.lastStderr = (entry.lastStderr + chunk.toString('utf8')).slice(-512)
      })
      child.once('exit', (code, signal) => {
        entry.exited = true
        if (managedServers.get(workspacePath) === entry) {
          managedServers.delete(workspacePath)
        }
        if (!disposed) {
          orca.log(
            `embedded viewer exited for ${workspacePath} (code=${String(code)}, signal=${String(signal)})${
              entry.lastStderr.trim() ? `: ${entry.lastStderr.trim()}` : ''
            }`,
          )
        }
      })

      const deadline = Date.now() + MANAGED_START_TIMEOUT_MS
      while (!disposed && !entry.exited && Date.now() < deadline) {
        const ep = readPluginEndpointFile(workspacePath)
        if (ep && ep.pid === child.pid) {
          await connectViewer(workspacePath, workspaceListId, ep)
          const conn = connections.get(workspacePath)
          if (conn?.connected) return conn
        }
        await new Promise((r) => setTimeout(r, MANAGED_POLL_INTERVAL_MS))
      }
      if (!entry.exited) stopManagedServer(workspacePath)
      return null
    })().finally(() => {
      startingServers.delete(workspacePath)
    })

    startingServers.set(workspacePath, promise)
    return await promise
  }

  orca.events.on('workspace.removed', (payload) => {
    state.workspaceCount += 1
    if (payload.path) {
      if (connections.has(payload.path)) disconnectViewer(payload.path)
      stopManagedServer(payload.path)
    }
    orca.log(`workspace.removed ${payload.workspaceId}`)
  })

  orca.hooks.on('agent.tool.after', (event) => {
    if (!toolStreamEnabled) return
    state.toolCount += 1
    const status = latestStatus(event.terminalId, event.workspaceId)
    const targets = matchingConnections(event.workspaceId, status?.workspaceListId)
    if (!event.terminalId) return
    const item = { terminalId: event.terminalId }
    for (const conn of targets) {
      pushRing(conn.queuedTools, item, MAX_STATUS_EVENTS)
      scheduleFlush(conn)
    }
  })

  function latestStatus(terminalId: string | undefined, workspaceId?: string | null) {
    if (!terminalId) return undefined
    for (let i = state.recentStatus.length - 1; i >= 0; i--) {
      const status = state.recentStatus[i]
      if (status.terminalId !== terminalId) continue
      if (workspaceId !== undefined && status.workspaceId !== workspaceId) return undefined
      return {
        workspaceId: typeof status.workspaceId === 'string' ? status.workspaceId : null,
        workspaceListId: typeof status.workspaceListId === 'string' ? status.workspaceListId : null,
      }
    }
    return undefined
  }

  orca.hooks.on('agent.prompt.before', (event) => {
    state.promptCount += 1
    const item = { terminalId: event.terminalId }
    const status = latestStatus(event.terminalId)
    for (const conn of matchingConnections(status?.workspaceId ?? null, status?.workspaceListId)) {
      pushRing(conn.queuedPrompts, item, MAX_STATUS_EVENTS)
      scheduleFlush(conn)
    }
    // Observe-only: returning nothing leaves the prompt untouched.
  })

  // --- Commands ---
  function connectionSummary() {
    return [...connections.values()].map((c) => ({
      workspacePath: c.workspacePath,
      workspaceListId: c.workspaceListId,
      port: c.endpoint.port,
      instanceId: c.endpoint.instanceId,
      connected: c.connected,
      lastSyncAt: c.lastSyncAt,
    }))
  }

  orca.commands.register('orchestration-panel.openTab', async (rawArgs) => {
    const conn = await resolveActiveViewer()
    if (!conn) {
      if (notifyEnabled && orca.host.has('notifications.show')) {
        void orca.host
          .call('notifications.show', {
            title: 'Orchestration Panel',
            body: 'No local Orca DAG viewer is running for this workspace. Start it with `npx orca-orchestration-launcher`.',
          })
          .catch(() => {})
      }
      return { ok: false, code: 'viewer_not_connected' }
    }
    const hash =
      rawArgs && typeof rawArgs === 'object' && typeof (rawArgs as { hash?: unknown }).hash === 'string'
        ? (rawArgs as { hash: string }).hash
        : ''
    const postOpenTab = async (forceRefresh: boolean) => {
      const token = await ensureMutationToken(conn, forceRefresh)
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (token) headers['x-orca-dag-token'] = token
      const res = await fetch(`http://127.0.0.1:${conn.endpoint.port}/api/open-tab`, {
        method: 'POST',
        headers,
        body: JSON.stringify(hash ? { hash } : {}),
        redirect: 'error',
        signal: AbortSignal.any([conn.abort.signal, AbortSignal.timeout(10_000)]),
      })
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      return { status: res.status, ok: res.ok, body }
    }
    try {
      let result = await postOpenTab(false)
      if (result.status === 403 && result.body.code === 'invalid_token') {
        result = await postOpenTab(true)
      }
      return result.ok ? { ok: true, ...result.body } : { ok: false, status: result.status, ...result.body }
    } catch (err) {
      return { ok: false, code: 'open_tab_failed', error: String((err as Error)?.message ?? err) }
    }
  })

  orca.commands.register('orchestration-panel.status', async () => ({
    plugin: PLUGIN_ID,
    version: PLUGIN_VERSION,
    activatedAt: state.activatedAt,
    uptimeMs: Date.now() - state.activatedAt,
    pluginApi: orca.api,
    grantedCapabilities: [...orca.grantedCapabilities],
    viewers: connectionSummary(),
    managedServers: [...managedServers.values()].map((m) => ({
      workspacePath: m.workspacePath,
      pid: m.child.pid ?? null,
      startedAt: m.startedAt,
    })),
    counts: {
      status: state.statusCount,
      tools: state.toolCount,
      prompts: state.promptCount,
      workspaces: state.workspaceCount,
      forwardedBatches: state.forwardedBatches,
    },
  }))

  orca.commands.register('orchestration-panel.reconnect', async () => {
    for (const key of [...connections.keys()]) disconnectViewer(key)
    await discoverViewers()
    return { ok: true, viewers: connectionSummary() }
  })

  function runSkillTool<T>(serverEntry: string, flag: '--install-plugin-skill' | '--uninstall-plugin-skill'): Promise<T> {
    // The worker selects the bundled executable and fixed action, never a
    // workspace path, launch argument from the caller, or external viewer.
    return execFileAsync(process.execPath, [serverEntry, flag], {
      cwd: dirname(serverEntry),
      timeout: 15_000,
      maxBuffer: 4096,
    }).then(({ stdout }) => JSON.parse(stdout) as T)
  }

  function installBundledSkill(): SkillInstallReply | Promise<SkillInstallReply> {
    if (!bundledAssets) return { ok: false, code: 'bundle_unavailable' }
    if (skillUninstall) return { ok: false, code: 'skill_busy' }

    // A confirmed write can complete after its caller closes. Share an install
    // already in flight between Orca commands and panels.
    return skillInstall ??= runSkillTool<SkillInstallReply>(bundledAssets.serverEntry, '--install-plugin-skill')
      .catch(() => ({ ok: false, code: 'install_failed' }) as const)
      .finally(() => { skillInstall = undefined })
  }

  orca.commands.register('orchestration-panel.installSkill', async (_args, { signal }) => {
    // Choosing this explicitly named install command is the user's action.
    // The sidebar uses its own confirmation before calling the same installer.
    if (signal.aborted) return 'Agent skill installation cancelled.'
    const result = await installBundledSkill()
    if (!result.ok) {
      if (result.code === 'skill_busy') return 'Skill removal is in progress. Try installing again after it finishes.'
      return result.code === 'bundle_unavailable'
        ? 'The orca-dag skill is missing from this plugin bundle.'
        : 'Could not confirm the orca-dag skill installation. Check the plugin bundle and local permissions.'
    }
    if (result.installed === 0 && result.upToDate === 0) {
      return 'No writable, supported Agent skill directory could be confirmed.'
    }
    return `orca-dag skill directories installed or updated: ${result.installed}. Already current: ${result.upToDate}.`
  })

  orca.commands.register('orchestration-panel.uninstallSkill', async (_args, { signal }) => {
    if (signal.aborted) return 'Agent skill removal cancelled.'
    if (!bundledAssets) return 'The orca-dag skill is missing from this plugin bundle.'
    if (skillInstall) return 'Skill installation is in progress. Try uninstalling again after it finishes.'

    skillUninstall ??= runSkillTool<SkillUninstallReply>(bundledAssets.serverEntry, '--uninstall-plugin-skill')
      .catch(() => ({ ok: false, code: 'uninstall_failed' }) as const)
      .finally(() => { skillUninstall = undefined })
    const result = await skillUninstall
    if (!result.ok) {
      return result.code === 'bundle_unavailable'
        ? 'The orca-dag skill is missing from this plugin bundle.'
        : 'Could not confirm orca-dag skill removal. Check the plugin bundle and local permissions.'
    }
    if (result.failed > 0) {
      return `Removed orca-dag skill files from ${result.removed} directories. Could not finish removal in ${result.failed}; check directory permissions.`
    }
    if (result.removed === 0) return 'No managed orca-dag skill files were removed.'
    return `Removed managed orca-dag skill files from ${result.removed} directories. User preferences were kept.`
  })

  // --- Panel & diagnostic handlers ---
  orca.panels.handle('orchestration-panel.probe', async (rawInput) => {
    const input = (rawInput ?? { action: 'ping' }) as ProbeRequest
    switch (input.action) {
      case 'ping':
        return {
          ok: true,
          plugin: PLUGIN_ID,
          version: PLUGIN_VERSION,
          pluginApi: orca.api,
          activatedAt: state.activatedAt,
          uptimeMs: Date.now() - state.activatedAt,
          grantedCapabilities: [...orca.grantedCapabilities],
          viewers: connectionSummary(),
          counts: {
            status: state.statusCount,
            tools: state.toolCount,
            prompts: state.promptCount,
            workspaces: state.workspaceCount,
            forwardedBatches: state.forwardedBatches,
          },
        }

      case 'events':
        return {
          activatedAt: state.activatedAt,
          uptimeMs: Date.now() - state.activatedAt,
          viewers: connectionSummary(),
          counts: {
            status: state.statusCount,
            tools: state.toolCount,
            prompts: state.promptCount,
            workspaces: state.workspaceCount,
            forwardedBatches: state.forwardedBatches,
          },
        }

      default:
        return { ok: false, error: `unknown action: ${String((input as { action?: unknown }).action)}` }
    }
  })

  // --- Panel SPA proxy (`orca-dag.api` + SSE streams) ---
  async function resolveViewer(workspaceId: string | null, allowSingleFallback = false): Promise<ViewerConnection | null> {
    if (!orca.host.has('workspace.list')) return null
    await discoverViewers()
    if (disposed) return null
    const inventory = await orca.host.call('workspace.list', {}).catch(() => null)
    if (!inventory) return null
    const locals = inventory.workspaces.filter((ws) => (ws.hostId === 'local' || ws.hostId === null) && Boolean(ws.path))
    const target = workspaceId ? locals.find((ws) => ws.id === workspaceId)
      : allowSingleFallback && locals.length === 1 ? locals[0] : undefined
    if (!target) return null
    const conn = connections.get(target.path)
    return conn?.connected ? conn : ensureManagedViewer(target.path, target.id)
  }

  async function resolveActiveViewer(): Promise<ViewerConnection | null> {
    const workspaceId = focusedWorkspaceId ?? (orca.host.has('workspace.readContext')
      ? (await orca.host.call('workspace.readContext', {}).catch(() => null))?.workspaceId
      : null)
    return resolveViewer(workspaceId ?? null, true)
  }

  async function ensureMutationToken(conn: ViewerConnection, forceRefresh = false): Promise<string | null> {
    if (!forceRefresh && conn.mutationToken) return conn.mutationToken
    try {
      const res = await fetch(`http://127.0.0.1:${conn.endpoint.port}/api/session`, {
        redirect: 'error',
        signal: conn.abort.signal,
      })
      if (!res.ok) return null
      const json = (await res.json()) as { token?: unknown }
      if (typeof json.token === 'string' && json.token) {
        conn.mutationToken = json.token
        return json.token
      }
      return null
    } catch {
      return null
    }
  }

  async function consumeSse(
    url: string,
    signal: AbortSignal,
    onFrame: (event: string, data: unknown) => void,
  ): Promise<void> {
    const res = await fetch(url, {
      headers: { accept: 'text/event-stream' },
      redirect: 'error',
      signal,
    })
    if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx = buffer.indexOf('\n\n')
        while (idx >= 0) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          let eventName = 'message'
          const dataLines: string[] = []
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          }
          if (dataLines.length > 0) {
            try {
              onFrame(eventName, JSON.parse(dataLines.join('\n')))
            } catch {
              // Ignore malformed SSE JSON frame.
            }
          }
          idx = buffer.indexOf('\n\n')
        }
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // Ignore reader cancel errors.
      }
    }
  }

  function safePostToPanel(panelId: string, event: 'orca-dag.activity' | 'orca-dag.output', payload: unknown): void {
    try {
      const encoded = JSON.stringify(payload)
      if (Buffer.byteLength(encoded, 'utf8') > MAX_PANEL_POST_BYTES) {
        // Trim oversized payload gracefully instead of tripping Orca's 256 KiB post cap.
        if (event === 'orca-dag.output' && payload && typeof payload === 'object') {
          const p = payload as { subId: string; event: string; data?: Record<string, unknown> }
          const out = p.data?.output as { lines?: string[]; messages?: unknown[] } | undefined
          if (out) {
            const trimmed = {
              ...p,
              data: {
                ...p.data,
                output: {
                  ...out,
                  lines: Array.isArray(out.lines) ? out.lines.slice(-160) : [],
                  ...(Array.isArray(out.messages) ? { messages: out.messages.slice(-60) } : {}),
                },
              },
            }
            if (Buffer.byteLength(JSON.stringify(trimmed), 'utf8') <= MAX_PANEL_POST_BYTES) {
              orca.panels.post(event, trimmed as never, { panel: panelId })
              return
            }
          }
        }
        if (event === 'orca-dag.activity' && payload && typeof payload === 'object') {
          const snap = payload as { events?: unknown[] }
          if (Array.isArray(snap.events)) {
            const trimmed = { ...snap, events: snap.events.slice(0, 60) }
            if (Buffer.byteLength(JSON.stringify(trimmed), 'utf8') <= MAX_PANEL_POST_BYTES) {
              orca.panels.post(event, trimmed as never, { panel: panelId })
              return
            }
          }
        }
        return
      }
      orca.panels.post(event, payload as never, { panel: panelId })
    } catch {
      // Panel may have closed.
    }
  }

  orca.panels.handle('orca-dag.skill.install', (input, { panel, signal }): SkillInstallReply | Promise<SkillInstallReply> => {
    if (panel.surface !== 'panel' || panel.contributionId !== 'orchestration' || input?.confirmed !== true || signal.aborted) {
      return { ok: false, code: 'confirmation_required' }
    }
    return installBundledSkill()
  })

  orca.panels.handle('orca-dag.api', async (rawInput, ctx): Promise<BridgeApiResponse> => {
    const req = (rawInput ?? {}) as Partial<BridgeApiRequest>
    const method = req.method === 'POST' || req.method === 'PUT' ? req.method : 'GET'
    const url = typeof req.url === 'string' ? req.url : ''
    if (!panelApiPath(url)) {
      return { status: 400, ok: false, body: { error: 'Invalid API path', code: 'invalid_path' } }
    }
    // Route the request to its originating workspace even if Orca has moved
    // focus since the frame issued it. Never infer a panel target from focus.
    const workspaceId = typeof req.workspaceId === 'string' ? req.workspaceId : ''
    const conn = workspaceId && !ctx.signal.aborted ? await resolveViewer(workspaceId) : null
    if (!conn) {
      return {
        status: 503,
        ok: false,
        body: {
          error: 'No local Orca DAG viewer is running for this workspace.',
          code: 'viewer_not_connected',
        },
      }
    }

    const execute = async (target: ViewerConnection, forceTokenRefresh: boolean): Promise<BridgeApiResponse> => {
      const headers: Record<string, string> = {}
      if (method !== 'GET') {
        headers['content-type'] = 'application/json'
        const token = await ensureMutationToken(target, forceTokenRefresh)
        if (token) headers['x-orca-dag-token'] = token
      }
      const res = await fetch(`http://127.0.0.1:${target.endpoint.port}${url}`, {
        method,
        headers,
        body: method !== 'GET' && req.body !== undefined ? JSON.stringify(req.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.any([target.abort.signal, ctx.signal, AbortSignal.timeout(30_000)]),
      })
      const text = await res.text()
      let body: Record<string, unknown>
      try {
        const parsed = JSON.parse(text) as unknown
        body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { data: parsed }
      } catch {
        body = { raw: text.slice(0, 4096) }
      }
      return { status: res.status, ok: res.ok, body }
    }

    try {
      const first = await execute(conn, false)
      if (method !== 'GET' && first.status === 403 && first.body.code === 'invalid_token') {
        return await execute(conn, true)
      }
      return first
    } catch (err) {
      // If an external viewer terminal just closed, drop the dead endpoint and
      // fail over seamlessly to the plugin's own embedded viewer server.
      const causeCode = (err as { cause?: { code?: string } })?.cause?.code
      if (!ctx.signal.aborted && !disposed) {
        if (connections.get(conn.workspacePath) === conn) disconnectViewer(conn.workspacePath)
        const recovered = await resolveViewer(workspaceId)
        if (recovered?.workspacePath === conn.workspacePath && (method === 'GET' || causeCode === 'ECONNREFUSED')) {
          try {
            return await execute(recovered, false)
          } catch {
            // Fall through to structured 502 error.
          }
        }
      }
      return {
        status: 502,
        ok: false,
        body: { error: String((err as Error)?.message ?? err), code: 'viewer_unreachable' },
      }
    }
  })

  async function connectPanelStream(
    streams: Map<string, AbortController>, key: string, workspaceId: string, requestSignal: AbortSignal,
  ): Promise<{ conn: ViewerConnection; controller: AbortController } | null> {
    // Register before awaiting discovery so unsubscribe can cancel a pending start.
    streams.get(key)?.abort()
    const controller = new AbortController()
    streams.set(key, controller)
    const conn = !requestSignal.aborted ? await resolveViewer(workspaceId) : null
    if (conn && !requestSignal.aborted && !controller.signal.aborted) return { conn, controller }
    if (streams.get(key) === controller) streams.delete(key)
    return null
  }

  function closePanelStream(streams: Map<string, AbortController>, input: unknown, panelId: string): void {
    const subId = (input as Partial<StreamSubscription> | null)?.subId
    if (typeof subId !== 'string' || !subId) return
    const key = `${panelId}\0${subId}`
    streams.get(key)?.abort()
    streams.delete(key)
  }

  orca.panels.handle('orca-dag.activity.subscribe', async (rawInput, ctx) => {
    const req = (rawInput ?? {}) as Partial<ActivitySubscribeRequest>
    const subId = typeof req.subId === 'string' ? req.subId : ''
    const runId = typeof req.runId === 'string' ? req.runId.trim() : ''
    if (!subId || !runId || typeof req.workspaceId !== 'string' || !req.workspaceId) return { ok: false }
    const panelId = ctx.panel.id
    const key = `${panelId}\0${subId}`
    const stream = await connectPanelStream(activityStreams, key, req.workspaceId, ctx.signal)
    if (!stream) return { ok: false }
    const { conn, controller } = stream
    const url = `http://127.0.0.1:${conn.endpoint.port}/api/activity/stream?run=${encodeURIComponent(runId)}`
    void consumeSse(url, AbortSignal.any([conn.abort.signal, controller.signal]), (event, data) => {
      // Like EventSource.onmessage, forward only snapshots. A named error
      // reports a failed read; the same stream can still deliver the next snapshot.
      if (event === 'message' && data && typeof data === 'object' && !controller.signal.aborted) {
        safePostToPanel(panelId, 'orca-dag.activity', { ...data, subId })
      }
    })
      .catch(() => {})
      .finally(() => {
        if (activityStreams.get(key) === controller) activityStreams.delete(key)
      })
    return { ok: true }
  })

  orca.panels.handle('orca-dag.activity.unsubscribe', (rawInput, ctx) => {
    closePanelStream(activityStreams, rawInput, ctx.panel.id)
    return { ok: true }
  })

  orca.panels.handle('orca-dag.output.subscribe', async (rawInput, ctx) => {
    const req = (rawInput ?? {}) as Partial<OutputSubscribeRequest>
    const subId = typeof req.subId === 'string' ? req.subId.trim() : ''
    const runId = typeof req.runId === 'string' ? req.runId.trim() : ''
    const dispatchId = typeof req.dispatchId === 'string' ? req.dispatchId.trim() : ''
    const source = req.source === 'terminal' || req.source === 'transcript' ? req.source : 'auto'
    if (!subId || !runId || !dispatchId || typeof req.workspaceId !== 'string' || !req.workspaceId) return { ok: false }

    const key = `${ctx.panel.id}\0${subId}`
    const stream = await connectPanelStream(outputStreams, key, req.workspaceId, ctx.signal)
    if (!stream) return { ok: false }
    const { conn, controller } = stream
    const params = new URLSearchParams({ run: runId })
    if (source !== 'auto') params.set('source', source)
    const url = `http://127.0.0.1:${conn.endpoint.port}/api/workers/${encodeURIComponent(dispatchId)}/output/stream?${params.toString()}`
    const panelId = ctx.panel.id
    void consumeSse(url, AbortSignal.any([conn.abort.signal, controller.signal]), (event, data) => {
      if (!controller.signal.aborted) safePostToPanel(panelId, 'orca-dag.output', { subId, event, data })
    })
      .catch((err) => {
        if (!controller.signal.aborted) {
          safePostToPanel(panelId, 'orca-dag.output', {
            subId,
            event: 'streamError',
            data: { error: String((err as Error)?.message ?? err) },
          })
        }
      })
      .finally(() => {
        if (outputStreams.get(key) === controller) outputStreams.delete(key)
      })
    return { ok: true }
  })

  orca.panels.handle('orca-dag.output.unsubscribe', (rawInput, ctx) => {
    closePanelStream(outputStreams, rawInput, ctx.panel.id)
    return { ok: true }
  })

  activeShutdown = () => {
    disposed = true
    clearInterval(discoveryTimer)
    for (const c of activityStreams.values()) c.abort()
    activityStreams.clear()
    for (const c of outputStreams.values()) c.abort()
    outputStreams.clear()
    for (const key of [...connections.keys()]) disconnectViewer(key)
    for (const path of [...managedServers.keys()]) stopManagedServer(path)
  }

  orca.log('orchestration-panel worker activated')
}

export function deactivate(): void {
  activeShutdown?.()
  activeShutdown = null
}
