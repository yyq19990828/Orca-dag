import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { pluginEndpointPath, pluginRequestToken, signPluginReply } from './endpoint'

const ALL_CAPABILITIES = [
  'workspace:read',
  'agent:read',
  'agent:launch',
  'history:read',
  'notifications:show',
  'storage:own',
  'settings:own',
] as const

test('activates, updates status bar, answers status command and ping probe', async () => {
  const host = mockHost({ capabilities: ALL_CAPABILITIES })
  const worker = await mountWorker(main, { host })

  const ping = await worker.request('orchestration-panel.probe', { action: 'ping' })
  assert.equal(ping.ok, true)
  assert.equal(ping.plugin, 'orchestration-panel')

  const status = (await worker.command('orchestration-panel.status')) as Record<string, unknown>
  assert.equal(status.plugin, 'orchestration-panel')

  assert.equal(worker.host.callsOf('statusBar.update').length, 1)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('records agent.status.changed, agent.tool.after, and passes agent.prompt.before untouched', async () => {
  const host = mockHost({
    capabilities: ALL_CAPABILITIES,
    settings: { toolStream: true },
  })
  const worker = await mountWorker(main, { host })

  await worker.emit('agent.status.changed', {
    workspaceId: 'ws-1',
    paneKey: 'tab:pane',
    terminalId: 'term_abc',
    state: 'working',
    receivedAt: 100,
    sessionId: 'sess-1',
  })

  await worker.hooks.fire('agent.tool.after', {
    agent: 'codex',
    workspaceId: 'ws-1',
    terminalId: 'term_abc',
    tool: 'exec',
    callId: 'call_1',
    input: { cmd: 'echo hello world from a long command' },
    output: { stdout: 'hello world from a long command' },
  })

  const promptDecision = await worker.hooks.fire('agent.prompt.before', {
    agent: 'codex',
    terminalId: 'term_abc',
    prompt: 'Do task X',
    inputKind: 'orchestration',
  })
  assert.equal(promptDecision.kind, 'continue')
  if (promptDecision.kind === 'continue') {
    assert.equal(promptDecision.event.prompt, 'Do task X')
  }

  const ev = await worker.request('orchestration-panel.probe', { action: 'events' })
  const counts = ev.counts as Record<string, number>
  assert.equal(counts.status, 1)
  assert.equal(counts.tools, 1)
  assert.equal(counts.prompts, 1)

  assert.equal(ev.recentTools, undefined)

  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('orca-dag.api rejects disallowed paths and returns 503 without a connected viewer', async () => {
  const host = mockHost({
    capabilities: ALL_CAPABILITIES,
    results: { 'workspace.list': { workspaces: [], truncated: false } },
  })
  const worker = await mountWorker(main, { host })

  for (const badUrl of [
    '/etc/passwd',
    '/api/../secret',
    '/api/plugin/events',
    '/api/plugin?foo=1',
    '/api/Plugin/events',
    '/api/workers/%2e%2e/plugin/events',
    '/api/workers\\output',
    '/api/activity/stream',
    '/api/runs HTTP/1.1',
  ]) {
    const res = await worker.request('orca-dag.api', { method: 'GET', url: badUrl })
    assert.equal(res.status, 400)
    assert.equal(res.ok, false)
    assert.equal(res.body.code, 'invalid_path')
  }

  const disconnected = await worker.request('orca-dag.api', { method: 'GET', url: '/api/runs' })
  assert.equal(disconnected.status, 503)
  assert.equal(disconnected.ok, false)
  assert.equal(disconnected.body.code, 'viewer_not_connected')

  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('connects to local viewer endpoint, proxies GET/POST with mutation token, and handles inbox commands', async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'odag-plugin-test-'))
  const pluginToken = 'a'.repeat(32)
  const requestToken = pluginRequestToken(pluginToken)
  const homeVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME'
  const previousHome = process.env[homeVar]
  const workspace = realpathSync(workspaceDir)
  const mutationToken = 'test-mutation-token-abcdef'
  const receipts = new Map<string, Record<string, unknown>>()
  let seenHello = false
  let seenPostToken: string | null = null
  let inboxDelivered = false
  const seenUrls: string[] = []
  const activitySnapshot = {
    runId: 'run_test',
    events: [],
    presence: [],
    checks: [],
    pendingCount: 0,
    truncated: false,
    inboxWindow: null,
    generatedAt: 42,
  }

  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    seenUrls.push(`${req.method} ${url}`)
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {}
      res.setHeader('content-type', 'application/json')
      const signed = (kind: 'hello' | 'inbox', payload: unknown) => {
        const nonce = req.headers['x-orca-plugin-nonce']
        assert.equal(typeof nonce, 'string')
        const text = JSON.stringify(payload)
        res.setHeader('x-orca-plugin-proof', signPluginReply(pluginToken, kind, String(nonce), text))
        res.end(text)
      }

      if (url === '/api/plugin/hello' && req.method === 'POST') {
        assert.equal(req.headers['x-orca-plugin-token'], requestToken)
        seenHello = true
        signed('hello', { ok: true, workspaceDir: workspace })
        return
      }
      if (url.startsWith('/api/plugin/inbox') && req.method === 'GET') {
        assert.equal(req.headers['x-orca-plugin-token'], requestToken)
        if (!inboxDelivered) {
          inboxDelivered = true
          signed('inbox', {
              commands: [
                { id: 'cmd-ws', kind: 'workspace.list', params: {} },
                {
                  id: 'cmd-resume',
                  kind: 'agent.resume',
                  params: { workspaceId: 'identity:wt2:local:ws-test', agent: 'codex', sessionId: 'sess-42' },
                },
              ],
              notifications: [],
              statusBar: null,
          })
          return
        }
        // Hold second poll until client aborts on deactivate.
        res.on('close', () => {
          if (!res.writableEnded) res.end()
        })
        return
      }
      if (url.startsWith('/api/plugin/receipts/') && req.method === 'POST') {
        assert.equal(req.headers['x-orca-plugin-token'], requestToken)
        const id = decodeURIComponent(url.slice('/api/plugin/receipts/'.length))
        receipts.set(id, body)
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url === '/api/session' && req.method === 'GET') {
        res.end(JSON.stringify({ token: mutationToken }))
        return
      }
      if (url === '/api/runs' && req.method === 'GET') {
        res.end(JSON.stringify({ runs: [{ id: 'run_test' }] }))
        return
      }
      if (url === '/api/activity/stream?run=run_test' && req.method === 'GET') {
        res.setHeader('content-type', 'text/event-stream')
        res.end(`event: error\ndata: {"error":"task-list temporarily unavailable"}\n\n` +
          `id: 42\ndata: ${JSON.stringify(activitySnapshot)}\n\n`)
        return
      }
      if (url === '/api/echo' && req.method === 'POST') {
        seenPostToken = String(req.headers['x-orca-dag-token'] ?? '')
        res.end(JSON.stringify({ echoed: body }))
        return
      }
      if (url === '/api/open-tab' && req.method === 'POST') {
        seenPostToken = String(req.headers['x-orca-dag-token'] ?? '')
        res.end(JSON.stringify({ ok: true, reused: true, pageId: 'page_tab_1', url: 'http://localhost:8787/' }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not found' }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0

  try {
    const fakeHome = join(workspaceDir, 'home')
    mkdirSync(fakeHome)
    process.env[homeVar] = fakeHome
    writeFileSync(
      pluginEndpointPath(workspaceDir, true),
      JSON.stringify({
        version: 2,
        port,
        pid: process.pid,
        instanceId: 'inst-test-1',
        pluginToken,
        workspace,
      }), { mode: 0o600 },
    )

    const host = mockHost({
      capabilities: ALL_CAPABILITIES,
      results: {
        'workspace.list': {
          workspaces: [
            {
              id: 'identity:wt2:local:ws-test',
              kind: 'worktree',
              path: workspaceDir,
              name: 'ws-test',
              branch: 'main',
              hostId: 'local',
            },
          ],
          truncated: false,
        },
        'agents.list': { agents: [] },
        'agent.resume': (params: { workspaceId: string; agent: string; sessionId: string }) => ({
          terminalId: `term_resumed_${params.sessionId}`,
          started: true,
        }),
      },
    })

    const activity = new EventEmitter()
    const worker = await mountWorker({
      ...main,
      default(orca: Parameters<typeof main.default>[0]) {
        main.default({
          ...orca,
          panels: {
            ...orca.panels,
            post(event: string, payload?: unknown, options?: { panel?: string }) {
              Reflect.apply(orca.panels.post, orca.panels, [event, payload, options])
              if (event === 'orca-dag.activity' && payload && typeof payload === 'object' && 'runId' in payload) {
                activity.emit('snapshot')
              }
            },
          },
        })
      },
    }, { host })
    try {
      // Wait for discovery + inbox command execution to settle.
      for (let i = 0; i < 40 && (!seenHello || receipts.size < 2); i++) {
        await new Promise((r) => setTimeout(r, 25))
      }

      assert.deepEqual(worker.refusals, [])
      assert.equal(seenHello, true)
      const wsReceipt = receipts.get('cmd-ws')
      assert.equal(wsReceipt?.ok, true)
      assert.ok(Array.isArray(wsReceipt?.workspaces))

      const resumeReceipt = receipts.get('cmd-resume')
      assert.equal(resumeReceipt?.ok, true)
      assert.equal(resumeReceipt?.terminalId, 'term_resumed_sess-42')
      assert.equal(resumeReceipt?.started, true)

      const getRes = await worker.request('orca-dag.api', { method: 'GET', url: '/api/runs' })
      assert.equal(getRes.ok, true)
      assert.equal(getRes.status, 200)
      assert.deepEqual(getRes.body, { runs: [{ id: 'run_test' }] })

      assert.deepEqual(
        await worker.request('orca-dag.skill.install', { confirmed: false }, { panel: 'orchestration' }),
        { ok: false, code: 'confirmation_required' },
      )
      assert.deepEqual(
        await worker.request('orca-dag.skill.install', { confirmed: true }, { panel: 'another-panel' }),
        { ok: false, code: 'confirmation_required' },
      )

      // A failed activity read is not a snapshot and must not cut off recovery.
      await Promise.all([
        once(activity, 'snapshot', { signal: AbortSignal.timeout(5_000) }),
        worker.request('orca-dag.activity.subscribe', { runId: 'run_test' }, { panel: 'orchestration' }),
      ])
      assert.deepEqual(
        worker.posts.filter(post => post.event === 'orca-dag.activity').map(post => post.payload),
        [activitySnapshot],
      )

      const postRes = await worker.request('orca-dag.api', {
        method: 'POST',
        url: '/api/echo',
        body: { hello: 'panel' },
      })
      assert.equal(postRes.ok, true)
      assert.equal(seenPostToken, mutationToken, `seenUrls=${JSON.stringify(seenUrls)}`)
      assert.deepEqual(postRes.body, { echoed: { hello: 'panel' } })

      const tabRes = (await worker.command('orchestration-panel.openTab', { hash: '#section=settings' })) as Record<
        string,
        unknown
      >
      assert.equal(tabRes.ok, true)
      assert.equal(tabRes.reused, true)
      assert.equal(tabRes.pageId, 'page_tab_1')

      // An unavailable focused workspace must not silently target the other viewer.
      await worker.emit('workspace.changed', {
        context: { workspaceId: 'identity:wt2:remote:other', branch: 'main', displayName: 'other', terminals: [] },
      })
      const outOfScope = await worker.request('orca-dag.api', { method: 'POST', url: '/api/echo', body: { hello: 'other' } })
      assert.equal(outOfScope.status, 503)
      assert.equal(seenUrls.filter((url) => url === 'POST /api/echo').length, 1)
      assert.deepEqual(worker.refusals, [])
    } finally {
      await worker.deactivate()
    }
  } finally {
    if (previousHome === undefined) delete process.env[homeVar]
    else process.env[homeVar] = previousHome
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(workspaceDir, { recursive: true, force: true })
  }
})
