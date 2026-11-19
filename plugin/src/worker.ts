// Orchestration Panel trusted-worker entry (M1 + M2 companion bridge).
//
// Responsibilities:
// 1. Discover local Orca DAG viewers via `<workspace>/.orca-dag/endpoint.json`
//    (never following symlinks) and connect over loopback HTTP (`127.0.0.1`).
// 2. Forward live `agent.status.changed`, `agent.tool.after` (observe-only),
//    and `agent.prompt.before` (observe-only) events to the matching viewer so
//    its centralized OutputTail wakes immediately and renders local tool calls.
// 3. Long-poll the viewer's `/api/plugin/inbox` to update Orca's status bar,
//    deliver gate/failure notifications, and execute approved host commands
//    (such as `agent.resume` in M3).
// 4. Keep `orchestration-panel.probe` & `orchestration-panel.status` available
//    for diagnostics and sidebar HTML panel integration.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import type {
  ActivitySubscribeRequest,
  BridgeApiRequest,
  BridgeApiResponse,
  OutputSubscribeRequest,
  OutputUnsubscribeRequest,
  ProbeRequest,
} from './protocol'

const PLUGIN_ID = 'orchestration-panel'
const PLUGIN_VERSION = '0.1.0'
const MAX_STATUS_EVENTS = 50
const MAX_TOOL_EVENTS = 50
const MAX_PROMPT_EVENTS = 20
const DEFAULT_MAX_TOOL_BYTES = 4096
const DISCOVERY_INTERVAL_MS = 10_000
const FLUSH_DEBOUNCE_MS = 100
const INBOX_WAIT_MS = 10_000
/** Orca caps panels.post at 256 KiB; stay comfortably below it. */
const MAX_PANEL_POST_BYTES = 220 * 1024
const MANAGED_START_TIMEOUT_MS = 8_000
const MANAGED_POLL_INTERVAL_MS = 80

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

interface EndpointFile {
  version: 1
  port: number
  pid: number
  instanceId: string
  pluginToken: string
  workspace: string
  worktree?: string
  startedAt?: string
}

interface ViewerConnection {
  workspacePath: string
  workspaceListId: string | null
  endpoint: EndpointFile
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
  recentTools: Array<Record<string, unknown>>
  recentPrompts: Array<Record<string, unknown>>
  lastWorkspace: Record<string, unknown> | null
}

let activeShutdown: (() => void) | null = null

function pushRing<T>(buf: T[], item: T, max: number): void {
  buf.push(item)
  if (buf.length > max) buf.splice(0, buf.length - max)
}

function truncateJson(value: unknown, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: value !== undefined }
  let raw: string
  try {
    raw = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  } catch {
    raw = '[unserializable]'
  }
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes <= maxBytes) return { text: raw, truncated: false }
  let end = Math.min(raw.length, maxBytes)
  while (end > 0 && Buffer.byteLength(raw.slice(0, end), 'utf8') > maxBytes) {
    end = Math.floor(end * 0.9)
  }
  return { text: raw.slice(0, end), truncated: true }
}

async function readLocalEndpoint(workspacePath: string): Promise<EndpointFile | null> {
  const dirPath = join(workspacePath, '.orca-dag')
  const filePath = join(dirPath, 'endpoint.json')
  try {
    const dirStat = await lstat(dirPath)
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null
    const fileStat = await lstat(filePath)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return null
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<EndpointFile>
    if (
      parsed.version !== 1 ||
      typeof parsed.port !== 'number' ||
      !Number.isInteger(parsed.port) ||
      parsed.port <= 0 ||
      parsed.port >= 65536 ||
      typeof parsed.pluginToken !== 'string' ||
      parsed.pluginToken.length < 8 ||
      typeof parsed.instanceId !== 'string' ||
      !parsed.instanceId ||
      typeof parsed.workspace !== 'string' ||
      !parsed.workspace
    ) {
      return null
    }
    return parsed as EndpointFile
  } catch {
    return null
  }
}

async function probeEnv(input: ProbeRequest): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {
    nodeVersion: process.version,
    pid: process.pid,
    cwd: process.cwd(),
  }

  const port = Number.isInteger(input.port) && input.port! > 0 && input.port! < 65536 ? input.port! : 8787
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal })
      const text = (await res.text()).slice(0, 256)
      result.s1_loopback = { ok: res.ok, status: res.status, bodyPreview: text }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    result.s1_loopback = { ok: false, error: String((err as Error)?.message ?? err) }
  }

  try {
    const target = typeof input.probePath === 'string' && input.probePath.length > 0 ? input.probePath : process.cwd()
    const st = await lstat(target)
    result.s2_fs = { ok: true, target, isDirectory: st.isDirectory(), isFile: st.isFile() }
  } catch (err) {
    result.s2_fs = { ok: false, error: String((err as Error)?.message ?? err) }
  }

  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const pExecFile = promisify(execFile)
    const bin = process.platform === 'linux' ? 'orca-ide' : 'orca'
    const { stdout } = await pExecFile(bin, ['--version'], { timeout: 3000 })
    result.s3_spawn = { ok: true, bin, version: String(stdout).trim() }
  } catch (err) {
    result.s3_spawn = { ok: false, error: String((err as Error)?.message ?? err) }
  }

  return result
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

  const state: RingState = {
    activatedAt: Date.now(),
    statusCount: 0,
    toolCount: 0,
    promptCount: 0,
    workspaceCount: 0,
    forwardedBatches: 0,
    recentStatus: [],
    recentTools: [],
    recentPrompts: [],
    lastWorkspace: null,
  }

  let maxToolBytes = DEFAULT_MAX_TOOL_BYTES
  let toolStreamEnabled = true
  let notifyEnabled = true

  async function loadSettings(): Promise<void> {
    if (!orca.host.has('settings.get')) return
    try {
      const { settings } = await orca.host.call('settings.get', {})
      if (typeof settings.toolStream === 'boolean') toolStreamEnabled = settings.toolStream
      if (typeof settings.notify === 'boolean') notifyEnabled = settings.notify
      if (typeof settings.maxToolOutputBytes === 'number' && Number.isFinite(settings.maxToolOutputBytes)) {
        maxToolBytes = Math.max(0, Math.min(65536, Math.round(settings.maxToolOutputBytes)))
      }
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
      'x-orca-plugin-token': conn.endpoint.pluginToken,
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
        signal: controller.signal,
      })
      if (res.status === 403) {
        // Stale token after viewer restart — drop and re-read endpoint.json.
        disconnectViewer(conn.workspacePath)
        return false
      }
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
    const statusEvents = conn.queuedStatus.splice(0, 100)
    const toolEvents = conn.queuedTools.splice(0, 100)
    const promptEvents = conn.queuedPrompts.splice(0, 50)
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
    const all = [...connections.values()].filter((c) => c.connected)
    if (all.length === 0) return []
    const matched = all.filter((conn) => {
      if (workspaceListId && conn.workspaceListId === workspaceListId) return true
      if (workspaceId && (workspaceId === conn.workspacePath || workspaceId.endsWith(`::${conn.workspacePath}`))) {
        return true
      }
      return false
    })
    return matched.length > 0 ? matched : workspaceId === null ? all : []
  }

  async function executeInboxCommand(
    conn: ViewerConnection,
    cmd: { id: string; kind: string; params?: Record<string, unknown> },
  ): Promise<void> {
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
      } else if (cmd.kind === 'agents.list') {
        if (!orca.host.has('agents.list')) {
          receipt = { ok: false, code: 'unsupported', error: 'agents.list unavailable' }
        } else {
          const req = typeof params.workspaceId === 'string' ? { workspaceId: params.workspaceId } : {}
          receipt = { ok: true, ...(await orca.host.call('agents.list', req)) }
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
        const res = await fetch(`http://127.0.0.1:${conn.endpoint.port}/api/plugin/inbox?waitMs=${INBOX_WAIT_MS}`, {
          method: 'GET',
          headers: { 'x-orca-plugin-token': conn.endpoint.pluginToken },
          signal: conn.abort.signal,
        })
        if (!res.ok) {
          disconnectViewer(conn.workspacePath)
          return
        }
        const data = (await res.json()) as {
          commands?: Array<{ id: string; kind: string; params?: Record<string, unknown> }>
          notifications?: Array<{ id: string; title: string; body?: string }>
          statusBar?: { text: string; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; tooltip?: string } | null
        }
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

  async function seedAgents(conn: ViewerConnection): Promise<void> {
    if (!orca.host.has('agents.list') || !conn.workspaceListId) return
    try {
      const { agents } = await orca.host.call('agents.list', { workspaceId: conn.workspaceListId })
      const rows = agents
        .filter((a) => typeof a.terminalId === 'string' && a.terminalId)
        .map((a) => ({
          terminalId: a.terminalId,
          workspaceListId: conn.workspaceListId,
          agent: a.agent,
          title: a.title,
          state: a.state,
          sessionId: a.sessionId ?? null,
        }))
      if (rows.length > 0) {
        await postJson(conn, '/api/plugin/events', { agents: rows })
      }
    } catch {
      // Best-effort initial snapshot.
    }
  }

  async function connectViewer(workspacePath: string, workspaceListId: string | null, endpoint: EndpointFile): Promise<void> {
    const existing = connections.get(workspacePath)
    if (
      existing &&
      existing.connected &&
      existing.endpoint.instanceId === endpoint.instanceId &&
      existing.endpoint.port === endpoint.port
    ) {
      existing.workspaceListId = workspaceListId ?? existing.workspaceListId
      return
    }
    if (existing) disconnectViewer(workspacePath)

    const conn: ViewerConnection = {
      workspacePath,
      workspaceListId,
      endpoint,
      abort: new AbortController(),
      connected: true,
      lastSyncAt: 0,
      mutationToken: null,
      queuedStatus: [],
      queuedTools: [],
      queuedPrompts: [],
      flushTimer: null,
    }
    connections.set(workspacePath, conn)

    const ok = await postJson(conn, '/api/plugin/hello', {
      pluginId: PLUGIN_ID,
      version: PLUGIN_VERSION,
      hostApiMinor: orca.api.minor,
      grantedCapabilities: [...orca.grantedCapabilities],
    })
    if (!ok || disposed || !conn.connected) {
      disconnectViewer(workspacePath)
      return
    }
    conn.lastSyncAt = Date.now()
    orca.log(`connected to viewer at 127.0.0.1:${endpoint.port} (${workspacePath})`)
    void seedAgents(conn)
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
          const endpoint = await readLocalEndpoint(ws.path)
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
      observedAt: Date.now(),
      workspaceId: payload.workspaceId,
      workspaceListId: payload.workspaceListId ?? null,
      paneKey: payload.paneKey,
      terminalId: payload.terminalId ?? null,
      title: payload.title ?? null,
      state: payload.state,
      mainAgent: payload.mainAgent ?? null,
      sessionId: payload.sessionId ?? null,
    }
    pushRing(state.recentStatus, item, MAX_STATUS_EVENTS)
    for (const conn of matchingConnections(payload.workspaceId, payload.workspaceListId ?? null)) {
      conn.queuedStatus.push(item)
      scheduleFlush(conn)
    }
  })

  orca.events.on('workspace.changed', (payload) => {
    state.workspaceCount += 1
    focusedWorkspaceId = payload.context?.workspaceId ?? null
    state.lastWorkspace = payload.context
      ? {
          workspaceId: payload.context.workspaceId ?? null,
          branch: payload.context.branch,
          displayName: payload.context.displayName,
          terminalCount: payload.context.terminals.length,
        }
      : null
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
    const existingEp = await readLocalEndpoint(workspacePath)
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
        const ep = await readLocalEndpoint(workspacePath)
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
    const inputSnap = truncateJson(event.input, maxToolBytes)
    const outputSnap = truncateJson(event.output, maxToolBytes)
    const item = {
      observedAt: Date.now(),
      agent: event.agent,
      workspaceId: event.workspaceId,
      terminalId: event.terminalId ?? null,
      tool: event.tool,
      callId: event.callId ?? null,
      inputPreview: inputSnap.text,
      inputTruncated: inputSnap.truncated,
      outputPreview: outputSnap.text,
      outputTruncated: outputSnap.truncated,
    }
    pushRing(state.recentTools, item, MAX_TOOL_EVENTS)
    for (const conn of matchingConnections(event.workspaceId, null)) {
      conn.queuedTools.push(item)
      scheduleFlush(conn)
    }
  })

  orca.hooks.on('agent.prompt.before', (event) => {
    state.promptCount += 1
    const item = {
      observedAt: Date.now(),
      agent: event.agent,
      terminalId: event.terminalId,
      inputKind: event.inputKind,
      promptBytes: Buffer.byteLength(event.prompt, 'utf8'),
    }
    pushRing(state.recentPrompts, item, MAX_PROMPT_EVENTS)
    for (const conn of connections.values()) {
      if (!conn.connected) continue
      conn.queuedPrompts.push(item)
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
        signal: AbortSignal.timeout(10_000),
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

      case 'env':
        return await probeEnv(input)

      case 'inventory': {
        const out: Record<string, unknown> = {}
        if (orca.host.has('workspace.readContext')) {
          out.focused = await orca.host.call('workspace.readContext', {}).catch((e: Error) => ({ error: e.message }))
        }
        if (orca.host.has('workspace.list')) {
          out.workspaces = await orca.host
            .call('workspace.list', { includeStatus: true })
            .catch((e: Error) => ({ error: e.message }))
        }
        if (orca.host.has('agents.list')) {
          const params = input.workspaceId ? { workspaceId: input.workspaceId } : {}
          out.agents = await orca.host.call('agents.list', params).catch((e: Error) => ({ error: e.message }))
        }
        if (input.workspaceId && orca.host.has('terminal.list')) {
          out.terminals = await orca.host
            .call('terminal.list', { workspaceId: input.workspaceId })
            .catch((e: Error) => ({ error: e.message }))
        }
        if (orca.host.has('agent.listSessions')) {
          const params = input.workspaceId ? { workspaceId: input.workspaceId, limit: 15 } : { limit: 15 }
          out.sessions = await orca.host
            .call('agent.listSessions', params)
            .catch((e: Error) => ({ error: e.message }))
        }
        return out
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
          lastWorkspace: state.lastWorkspace,
          recentStatus: state.recentStatus,
          recentTools: state.recentTools,
          recentPrompts: state.recentPrompts,
        }

      case 'resume': {
        if (!input.workspaceId || !input.agent || !input.sessionId) {
          return { ok: false, error: 'workspaceId, agent, and sessionId are required' }
        }
        if (!orca.host.has('agent.resume')) {
          return { ok: false, error: 'agent.resume is unavailable on this Orca host' }
        }
        const res = await orca.host.call('agent.resume', {
          workspaceId: input.workspaceId,
          agent: input.agent as Parameters<typeof orca.host.call<'agent.resume'>>[1]['agent'],
          sessionId: input.sessionId,
        })
        return { ok: true, ...res }
      }

      default:
        return { ok: false, error: `unknown action: ${String((input as { action?: unknown }).action)}` }
    }
  })

  // --- Panel SPA proxy (`orca-dag.api` + SSE streams) ---
  async function resolveActiveViewer(): Promise<ViewerConnection | null> {
    if (connections.size === 0) await discoverViewers()
    const live = [...connections.values()].filter((c) => c.connected)
    if (focusedWorkspaceId) {
      const focusedMatch = live.find((c) => c.workspaceListId === focusedWorkspaceId)
      if (focusedMatch) return focusedMatch
    }

    // Self-contained fallback: automatically start an isolated embedded viewer
    // server for the focused (or first local) Orca workspace when no external
    // viewer terminal is running for it.
    if (bundledAssets && orca.host.has('workspace.list')) {
      try {
        if (!focusedWorkspaceId && orca.host.has('workspace.readContext')) {
          const ctx = await orca.host.call('workspace.readContext', {}).catch(() => null)
          if (ctx?.workspaceId) focusedWorkspaceId = ctx.workspaceId
        }
        const { workspaces } = await orca.host.call('workspace.list', {})
        const locals = workspaces.filter((ws) => (ws.hostId === 'local' || ws.hostId === null) && Boolean(ws.path))
        const target =
          (focusedWorkspaceId && locals.find((ws) => ws.id === focusedWorkspaceId)) ||
          (live.length === 0 ? locals[0] : undefined)
        if (target) {
          const started = await ensureManagedViewer(target.path, target.id)
          if (started) return started
        }
      } catch {
        // Fall through to any other connected viewer below.
      }
    }

    return live[0] ?? null
  }

  async function ensureMutationToken(conn: ViewerConnection, forceRefresh = false): Promise<string | null> {
    if (!forceRefresh && conn.mutationToken) return conn.mutationToken
    try {
      const res = await fetch(`http://127.0.0.1:${conn.endpoint.port}/api/session`, {
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

  orca.panels.handle('orca-dag.api', async (rawInput, ctx): Promise<BridgeApiResponse> => {
    const req = (rawInput ?? {}) as Partial<BridgeApiRequest>
    const method = req.method === 'POST' || req.method === 'PUT' ? req.method : 'GET'
    const url = typeof req.url === 'string' ? req.url : ''
    if (
      !url.startsWith('/api/') ||
      url.includes('..') ||
      /[\r\n\s]/.test(url) ||
      /^\/api\/plugin([/?#]|$)/.test(url)
    ) {
      return { status: 400, ok: false, body: { error: 'Invalid API path', code: 'invalid_path' } }
    }
    const conn = await resolveActiveViewer()
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
        signal: ctx.signal,
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
      if (!ctx.signal.aborted) {
        disconnectViewer(conn.workspacePath)
        const recovered = await resolveActiveViewer()
        if (recovered && (method === 'GET' || causeCode === 'ECONNREFUSED')) {
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

  orca.panels.handle('orca-dag.activity.subscribe', async (rawInput, ctx) => {
    const req = (rawInput ?? {}) as Partial<ActivitySubscribeRequest>
    const runId = typeof req.runId === 'string' ? req.runId.trim() : ''
    if (!runId) return { ok: false }
    const key = ctx.panel.id
    activityStreams.get(key)?.abort()
    activityStreams.delete(key)

    const conn = await resolveActiveViewer()
    if (!conn) return { ok: false }
    const controller = new AbortController()
    activityStreams.set(key, controller)
    const url = `http://127.0.0.1:${conn.endpoint.port}/api/activity/stream?run=${encodeURIComponent(runId)}`
    void consumeSse(url, controller.signal, (_event, data) => {
      safePostToPanel(key, 'orca-dag.activity', data)
    })
      .catch(() => {})
      .finally(() => {
        if (activityStreams.get(key) === controller) activityStreams.delete(key)
      })
    return { ok: true }
  })

  orca.panels.handle('orca-dag.activity.unsubscribe', async (_rawInput, ctx) => {
    const key = ctx.panel.id
    activityStreams.get(key)?.abort()
    activityStreams.delete(key)
    return { ok: true }
  })

  orca.panels.handle('orca-dag.output.subscribe', async (rawInput, ctx) => {
    const req = (rawInput ?? {}) as Partial<OutputSubscribeRequest>
    const subId = typeof req.subId === 'string' ? req.subId.trim() : ''
    const runId = typeof req.runId === 'string' ? req.runId.trim() : ''
    const dispatchId = typeof req.dispatchId === 'string' ? req.dispatchId.trim() : ''
    const source = req.source === 'terminal' || req.source === 'transcript' ? req.source : 'auto'
    if (!subId || !runId || !dispatchId) return { ok: false }

    outputStreams.get(subId)?.abort()
    outputStreams.delete(subId)

    const conn = await resolveActiveViewer()
    if (!conn) return { ok: false }
    const controller = new AbortController()
    outputStreams.set(subId, controller)
    const params = new URLSearchParams({ run: runId })
    if (source !== 'auto') params.set('source', source)
    const url = `http://127.0.0.1:${conn.endpoint.port}/api/workers/${encodeURIComponent(dispatchId)}/output/stream?${params.toString()}`
    const panelId = ctx.panel.id
    void consumeSse(url, controller.signal, (event, data) => {
      safePostToPanel(panelId, 'orca-dag.output', { subId, event, data })
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
        if (outputStreams.get(subId) === controller) outputStreams.delete(subId)
      })
    return { ok: true }
  })

  orca.panels.handle('orca-dag.output.unsubscribe', async (rawInput) => {
    const req = (rawInput ?? {}) as Partial<OutputUnsubscribeRequest>
    const subId = typeof req.subId === 'string' ? req.subId.trim() : ''
    if (subId) {
      outputStreams.get(subId)?.abort()
      outputStreams.delete(subId)
    }
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
