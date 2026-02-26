import { loadConfig } from 'c12'
import { z } from 'zod'
import { config as loadEnv } from 'dotenv'

// Load .env file before processing configuration
loadEnv()

const configSchema = z.object({
  llm: z.object({
    apiKey: z.string(),
    defaultModel: z.string(),
    baseUrl: z.string().url(),
  }),
  telegram: z.object({
    botToken: z.string(),
    allowedUserIds: z.union([z.array(z.number()), z.string()]).transform((val) => {
      if (typeof val === 'string') {
        return val.split(',').map((id) => parseInt(id.trim(), 10)).filter((id) => !isNaN(id))
      }
      return val
    }),
  }),
  memory: z.object({
    enabled: z.boolean(),
    dir: z.string(),
    summaryWindowMinutes: z.union([z.number(), z.string()]).transform((val) => {
      if (typeof val === 'string') {
        const parsed = parseInt(val, 10)
        return isNaN(parsed) ? 30 : parsed
      }
      return val
    }),
    autoSummarize: z.union([z.boolean(), z.string()]).transform((val) => {
      if (typeof val === 'string') {
        return val.toLowerCase() === 'true'
      }
      return val
    }),
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error', 'silent']),
    file: z.string(),
  }),
  workers: z.object({
    searchPoolSize: z.number().default(2),
    shellPoolSize: z.number().default(3),
  }),
  tools: z.object({
    maxParallel: z.number().default(5),
  }),
})

export type JarvisConfig = z.infer<typeof configSchema>

// Environment variable to config path mapping
const envMapping: Record<string, string[]> = {
  SYNTHETIC_API_KEY: ['llm', 'apiKey'],
  DEFAULT_MODEL: ['llm', 'defaultModel'],
  TELEGRAM_BOT_TOKEN: ['telegram', 'botToken'],
  TELEGRAM_ALLOWED_USER_IDS: ['telegram', 'allowedUserIds'],
  JARVIS_MEMORY_DIR: ['memory', 'dir'],
  JARVIS_MEMORY_SUMMARY_WINDOW_MINUTES: ['memory', 'summaryWindowMinutes'],
  JARVIS_AUTO_SUMMARIZE: ['memory', 'autoSummarize'],
  JARVIS_LOG_LEVEL: ['logging', 'level'],
  JARVIS_LOG_FILE: ['logging', 'file'],
}

let cachedConfig: JarvisConfig | null = null

export async function getConfig(): Promise<JarvisConfig> {
  if (cachedConfig) {
    return cachedConfig
  }

  // Load base config from JSON files
  const { config: rawConfig } = await loadConfig({
    name: 'jarvis',
    configFile: '.config/default',
    envName: process.env.NODE_ENV ?? 'development',
  })

  // Merge environment variables
  const mergedConfig = mergeEnvVars(rawConfig)

  // Validate with Zod
  const result = configSchema.safeParse(mergedConfig)

  if (!result.success) {
    console.error('❌ Configuration validation failed:')
    console.error(result.error.format())
    throw new Error('Invalid configuration')
  }

  cachedConfig = result.data
  return result.data
}

function mergeEnvVars(config: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...config }

  for (const [envVar, path] of Object.entries(envMapping)) {
    const value = process.env[envVar]
    if (value !== undefined) {
      setNestedValue(merged, path, value)
    }
  }

  return merged
}

function setNestedValue(obj: Record<string, unknown>, path: string[], value: string): void {
  let current: Record<string, unknown> = obj
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = {}
    }
    current = current[key] as Record<string, unknown>
  }
  current[path[path.length - 1]] = value
}

export function clearConfigCache(): void {
  cachedConfig = null
}

/**
 * Log configuration values, masking sensitive fields
 */
export function logConfig(logger: { info: (obj: Record<string, unknown>, msg: string) => void }, config: JarvisConfig): void {
  const safeConfig = {
    llm: {
      defaultModel: config.llm.defaultModel,
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey ? '***set***' : '***NOT SET***',
    },
    telegram: {
      botToken: config.telegram.botToken ? '***set***' : '***NOT SET***',
      allowedUserIds: config.telegram.allowedUserIds,
    },
    memory: {
      enabled: config.memory.enabled,
      dir: config.memory.dir || '(default)',
      summaryWindowMinutes: config.memory.summaryWindowMinutes,
      autoSummarize: config.memory.autoSummarize,
    },
    logging: {
      level: config.logging.level,
      file: config.logging.file || '(none)',
    },
    workers: {
      searchPoolSize: config.workers.searchPoolSize,
      shellPoolSize: config.workers.shellPoolSize,
    },
    tools: {
      maxParallel: config.tools.maxParallel,
    },
  }

  logger.info(safeConfig, 'Configuration loaded')
}
