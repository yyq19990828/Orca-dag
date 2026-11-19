import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

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
    settings: { toolStream: true, maxToolOutputBytes: 16 },
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

  const tools = ev.recentTools as Array<Record<string, unknown>>
  assert.equal(tools[0].tool, 'exec')
  assert.equal(tools[0].inputTruncated, true)
  assert.ok(Buffer.byteLength(String(tools[0].inputPreview), 'utf8') <= 16)

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
  const pluginToken = 'test-plugin-token-123456'
  const mutationToken = 'test-mutation-token-abcdef'
  const receipts = new Map<string, Record<string, unknown>>()
  let seenHello = false
  let seenPostToken: string | null = null
  let inboxDelivered = false
  const seenUrls: string[] = []

  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    seenUrls.push(`${req.method} ${url}`)
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {}
      res.setHeader('content-type', 'application/json')

      if (url === '/api/plugin/hello' && req.method === 'POST') {
        assert.equal(req.headers['x-orca-plugin-token'], pluginToken)
        seenHello = true
        res.end(JSON.stringify({ ok: true, statusBar: { text: '1/3 running', tone: 'accent' } }))
        return
      }
      if (url.startsWith('/api/plugin/inbox') && req.method === 'GET') {
        assert.equal(req.headers['x-orca-plugin-token'], pluginToken)
        if (!inboxDelivered) {
          inboxDelivered = true
          res.end(
            JSON.stringify({
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
            }),
          )
          return
        }
        // Hold second poll until client aborts on deactivate.
        res.on('close', () => {
          if (!res.writableEnded) res.end()
        })
        return
      }
      if (url.startsWith('/api/plugin/receipts/') && req.method === 'POST') {
        assert.equal(req.headers['x-orca-plugin-token'], pluginToken)
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
    mkdirSync(join(workspaceDir, '.orca-dag'), { recursive: true })
    writeFileSync(
      join(workspaceDir, '.orca-dag', 'endpoint.json'),
      JSON.stringify({
        version: 1,
        port,
        pid: process.pid,
        instanceId: 'inst-test-1',
        pluginToken,
        workspace: workspaceDir,
      }),
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

    const worker = await mountWorker(main, { host })
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

      assert.deepEqual(worker.refusals, [])
    } finally {
      await worker.deactivate()
    }
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(workspaceDir, { recursive: true, force: true })
  }
})
