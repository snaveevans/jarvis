import pino from 'pino'
import type { JarvisConfig } from './config.ts'

export interface LoggerConfig {
  level?: string
  filePath?: string
  toStdout?: boolean
}

export function createLogger(config: LoggerConfig = {}): pino.Logger {
  const level = config.level ?? 'info'
  const filePath = config.filePath
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
