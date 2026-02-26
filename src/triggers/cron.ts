import { createLogger } from '../logger.ts'

import type { Dispatcher } from '../dispatcher.ts'
import type { LoggerConfig } from '../logger.ts'

export interface CronTask {
  readonly name: string
  readonly intervalMs: number
  readonly targetSessionId: string
  readonly targetEndpointKind: string
  readonly prompt: string
}

export interface CronSchedulerConfig {
  tasks: CronTask[]
  dispatcher: Dispatcher
  logger?: LoggerConfig
}

export interface CronScheduler {
  start(): void
  stop(): void
}

export function createCronScheduler(config: CronSchedulerConfig): CronScheduler {
  const logger = createLogger(config.logger)
  const timers: ReturnType<typeof setInterval>[] = []

  return {
    start(): void {
      for (const task of config.tasks) {
        logger.info(
          { name: task.name, intervalMs: task.intervalMs, target: task.targetSessionId },
          'Scheduling cron task'
        )

        const timer = setInterval(async () => {
          logger.info({ name: task.name }, 'Cron task firing')
          try {
            await config.dispatcher.sendProactive({
              sessionId: task.targetSessionId,
              endpointKind: task.targetEndpointKind,
              text: task.prompt,
            })
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            logger.error({ name: task.name, error: msg }, 'Cron task failed')
          }
        }, task.intervalMs)

        timers.push(timer)
      }
    },

    stop(): void {
      for (const timer of timers) {
        clearInterval(timer)
      }
      timers.length = 0
      logger.info('Cron scheduler stopped')
    },
  }
}
