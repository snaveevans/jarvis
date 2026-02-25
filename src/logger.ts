import pino from 'pino'

export interface LoggerConfig {
  level?: string
  filePath?: string
  toStdout?: boolean
}

export function createLogger(config: LoggerConfig = {}): pino.Logger {
  const level = config.level ?? process.env.JARVIS_LOG_LEVEL ?? 'info'
  const filePath = config.filePath ?? process.env.JARVIS_LOG_FILE
  const toStdout = config.toStdout ?? true

  if (!filePath) {
    return pino({ level })
  }

  const fileDestination = pino.destination({
    dest: filePath,
    mkdir: true,
    sync: true,
  })

  if (!toStdout) {
    return pino({ level }, fileDestination)
  }

  return pino(
    { level },
    pino.multistream([
      { stream: process.stdout },
      { stream: fileDestination },
    ])
  )
}
