export interface ShellJob {
  command: string
  cwd: string
  timeout: number
  maxBuffer: number
}

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

export interface ShellPool {
  exec(job: ShellJob): Promise<ShellResult>
  shutdown(): void
  readonly queueLength: number
  readonly activeCount: number
}
