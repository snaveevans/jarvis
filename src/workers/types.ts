export interface WorkerRequest {
  requestId: string
  method: string
  params: Record<string, unknown>
}

export interface WorkerResponse {
  requestId: string
  result?: unknown
  error?: string
}
