// Shared request/event contract between the Orchestration Panel HTML frame and trusted-worker.

export interface ProbeRequest {
  action: 'ping' | 'events'
}

export interface BridgeApiRequest {
  method: 'GET' | 'POST' | 'PUT'
  url: string
  body?: unknown
}

export interface BridgeApiResponse {
  status: number
  ok: boolean
  body: Record<string, unknown>
}

export interface ActivitySubscribeRequest {
  runId: string
}

export interface OutputSubscribeRequest {
  subId: string
  runId: string
  dispatchId: string
  source?: 'auto' | 'terminal' | 'transcript'
}

export interface OutputUnsubscribeRequest {
  subId: string
}

declare module 'orca' {
  interface PluginRequests {
    'orchestration-panel.probe': {
      input: ProbeRequest
      output: Record<string, unknown>
    }
    'orca-dag.api': {
      input: BridgeApiRequest
      output: BridgeApiResponse
    }
    'orca-dag.activity.subscribe': {
      input: ActivitySubscribeRequest
      output: { ok: boolean }
    }
    'orca-dag.activity.unsubscribe': {
      input: ActivitySubscribeRequest
      output: { ok: boolean }
    }
    'orca-dag.output.subscribe': {
      input: OutputSubscribeRequest
      output: { ok: boolean }
    }
    'orca-dag.output.unsubscribe': {
      input: OutputUnsubscribeRequest
      output: { ok: boolean }
    }
  }

  interface PluginPanelEvents {
    'orchestration-panel.status': {
      connected: boolean
      activatedAt: number
    }
    'orca-dag.activity': Record<string, unknown>
    'orca-dag.output': {
      subId: string
      event: string
      data: unknown
    }
  }
}
