// extensions/opencode/src/types.ts
// Type definitions for Locutus OpenCode Ear extension.

export interface SessionEntry {
  agent?: string
  status?: "active" | "closed" | string
  disabled?: boolean
  updated_at?: string
  closed_at?: string
  task_id?: string
  strand_path?: string
  rifttree_path?: string
}

export interface SubprocessHandle {
  kill: (signal?: string | number) => void
  pid?: number
  stdout?: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null
  stderr?: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null
}

export interface ListenerState {
  aborted: boolean
  proc: SubprocessHandle | null
}

export interface OpenCodeEvent {
  type: string
  properties?: {
    info?: OpenCodeSessionInfo
    [key: string]: unknown
  }
}

export interface ActiveListener {
  state: ListenerState
  targetSessionId: string | null
}

export interface OpenCodeSessionInfo {
  id: string
  time?: {
    created?: number
    updated?: number
    archived?: number
  }
}

export interface OpenCodeClient {
  session?: {
    list: () => Promise<OpenCodeSessionInfo[] | { data: OpenCodeSessionInfo[] }>
    status?: () => Promise<any>
    abort?: (params: { path: { id: string } }) => Promise<any>
    promptAsync?: (payload: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }) => Promise<any>
    prompt?: (payload: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }) => Promise<any>
  }
}

export interface PluginContext {
  client: OpenCodeClient
  directory?: string
}
