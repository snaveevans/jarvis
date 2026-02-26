import { loadConfig } from 'c12'
import { z } from 'zod'
import { config as loadEnv } from 'dotenv'
import { LLM_PROVIDERS } from './llm/provider.ts'

// Load .env file only in development mode
if (process.env.NODE_ENV === 'development') {
  loadEnv()
}

const PROVIDER_DEFAULT_BASE_URLS = {
  synthetic: 'https://api.synthetic.new/openai/v1',
  minimax: 'https://api.minimax.io/v1',
  'openai-compatible': '',
} as const

const providerConfigSchema = z.object({
  apiKey: z.string().default(''),
  baseUrl: z.string().default(''),
  defaultModel: z.string().default(''),
})

const numStr = (fallback: number) =>
  z.union([z.number(), z.string()]).transform((val) => {
    if (typeof val === 'string') {
      const parsed = parseInt(val, 10)
      return parsed > 0 ? parsed : fallback
    }
    return typeof val === 'number' && val > 0 ? val : fallback
  }).default(fallback)

const configSchema = z.object({
  llm: z.object({
    apiKey: z.string().default(''),
    defaultModel: z.string().default(''),
    baseUrl: z.string().default(''),
    defaultPrompt: z.string().default(''),
    provider: z.enum(LLM_PROVIDERS).default('synthetic'),
    providers: z.object({
      synthetic: providerConfigSchema.default({}),
      minimax: providerConfigSchema.default({}),
      openaiCompatible: providerConfigSchema.default({}),
    }).default({}),
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
    archiveRetentionDays: z.union([z.number(), z.string()]).transform((val) => {
      if (typeof val === 'string') {
        const parsed = parseInt(val, 10)
        return isNaN(parsed) ? 14 : parsed
      }
      return val
    }).default(14),
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
    autoContextMaxResults: numStr(5),
    autoContextMaxTokens: numStr(500),
    searchMaxLimit: numStr(20),
    searchDefaultLimit: numStr(5),
    recentDefaultLimit: numStr(10),
    minSummaryTokens: numStr(200),
    tokenEstimationCharsPerToken: numStr(4),
  }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error', 'silent']),
    file: z.string(),
  }),
  history: z.object({
    enabled: z.union([z.boolean(), z.string()]).transform((val) => {
      if (typeof val === 'string') {
        return val.toLowerCase() === 'true'
      }
      return val
    }).default(true),
    dbPath: z.string().default('data/session-history.db'),
    retentionHours: numStr(72),
    rehydrateMaxMessages: numStr(200),
  }),
  workers: z.object({
    searchPoolSize: z.number().default(2),
    shellPoolSize: z.number().default(3),
  }),
  search: z.object({
    provider: z.enum(['brave', 'synthetic']).default('brave'),
    defaultLimit: numStr(5),
    maxLimit: numStr(10),
    timeoutMs: numStr(15_000),
    brave: z.object({
      apiKey: z.string().default(''),
      baseUrl: z.string().default('https://api.search.brave.com/res/v1/web/search'),
    }),
    synthetic: z.object({
      apiKey: z.string().default(''),
      baseUrl: z.string().default('https://api.synthetic.new/v2/search'),
    }),
  }),
  tools: z.object({
    maxParallel: numStr(5),
    maxIterations: numStr(5),
    maxOutputCharacters: numStr(50_000),
    maxOutputLines: numStr(2_000),
    maxLineLength: numStr(2_000),
    timeoutMs: numStr(120_000),
    maxGlobResults: numStr(1_000),
    maxGrepMatches: numStr(1_000),
    maxReadLines: numStr(2_000),
    eventStoreSize: numStr(500),
  }),
})

export type JarvisConfig = z.infer<typeof configSchema>

// Environment variable to config path mapping
const envMapping: Record<string, string[]> = {
  SYNTHETIC_API_KEY: ['llm', 'providers', 'synthetic', 'apiKey'],
  DEFAULT_MODEL: ['llm', 'defaultModel'],
  SYNTHETIC_DEFAULT_MODEL: ['llm', 'providers', 'synthetic', 'defaultModel'],
  SYNTHETIC_BASE_URL: ['llm', 'providers', 'synthetic', 'baseUrl'],
  MINIMAX_API_KEY: ['llm', 'providers', 'minimax', 'apiKey'],
  MINIMAX_DEFAULT_MODEL: ['llm', 'providers', 'minimax', 'defaultModel'],
  MINIMAX_BASE_URL: ['llm', 'providers', 'minimax', 'baseUrl'],
  OPENAI_API_KEY: ['llm', 'providers', 'openaiCompatible', 'apiKey'],
  OPENAI_BASE_URL: ['llm', 'providers', 'openaiCompatible', 'baseUrl'],
  OPENAI_COMPATIBLE_API_KEY: ['llm', 'providers', 'openaiCompatible', 'apiKey'],
  OPENAI_COMPATIBLE_DEFAULT_MODEL: ['llm', 'providers', 'openaiCompatible', 'defaultModel'],
  OPENAI_COMPATIBLE_BASE_URL: ['llm', 'providers', 'openaiCompatible', 'baseUrl'],
  LLM_API_KEY: ['llm', 'apiKey'],
  LLM_BASE_URL: ['llm', 'baseUrl'],
  LLM_PROVIDER: ['llm', 'provider'],
  JARVIS_DEFAULT_PROMPT: ['llm', 'defaultPrompt'],
  TELEGRAM_BOT_TOKEN: ['telegram', 'botToken'],
  TELEGRAM_ALLOWED_USER_IDS: ['telegram', 'allowedUserIds'],
  JARVIS_MEMORY_DIR: ['memory', 'dir'],
  JARVIS_MEMORY_ARCHIVE_RETENTION_DAYS: ['memory', 'archiveRetentionDays'],
  JARVIS_MEMORY_SUMMARY_WINDOW_MINUTES: ['memory', 'summaryWindowMinutes'],
  JARVIS_AUTO_SUMMARIZE: ['memory', 'autoSummarize'],
  JARVIS_MEMORY_AUTO_CONTEXT_MAX_RESULTS: ['memory', 'autoContextMaxResults'],
  JARVIS_MEMORY_AUTO_CONTEXT_MAX_TOKENS: ['memory', 'autoContextMaxTokens'],
  JARVIS_MEMORY_SEARCH_MAX_LIMIT: ['memory', 'searchMaxLimit'],
  JARVIS_MEMORY_SEARCH_DEFAULT_LIMIT: ['memory', 'searchDefaultLimit'],
  JARVIS_MEMORY_RECENT_DEFAULT_LIMIT: ['memory', 'recentDefaultLimit'],
  JARVIS_MEMORY_MIN_SUMMARY_TOKENS: ['memory', 'minSummaryTokens'],
  JARVIS_TOKEN_ESTIMATION_CHARS_PER_TOKEN: ['memory', 'tokenEstimationCharsPerToken'],
  JARVIS_LOG_LEVEL: ['logging', 'level'],
  JARVIS_LOG_FILE: ['logging', 'file'],
  JARVIS_HISTORY_ENABLED: ['history', 'enabled'],
  JARVIS_HISTORY_DB_PATH: ['history', 'dbPath'],
  JARVIS_HISTORY_RETENTION_HOURS: ['history', 'retentionHours'],
  JARVIS_HISTORY_REHYDRATE_MAX_MESSAGES: ['history', 'rehydrateMaxMessages'],
  JARVIS_SEARCH_PROVIDER: ['search', 'provider'],
  JARVIS_SEARCH_DEFAULT_LIMIT: ['search', 'defaultLimit'],
  JARVIS_SEARCH_MAX_LIMIT: ['search', 'maxLimit'],
  JARVIS_SEARCH_TIMEOUT_MS: ['search', 'timeoutMs'],
  BRAVE_API_KEY: ['search', 'brave', 'apiKey'],
  BRAVE_SEARCH_BASE_URL: ['search', 'brave', 'baseUrl'],
  SYNTHETIC_SEARCH_API_KEY: ['search', 'synthetic', 'apiKey'],
  SYNTHETIC_SEARCH_BASE_URL: ['search', 'synthetic', 'baseUrl'],
  JARVIS_TOOLS_MAX_PARALLEL: ['tools', 'maxParallel'],
  JARVIS_TOOLS_MAX_ITERATIONS: ['tools', 'maxIterations'],
  JARVIS_TOOLS_MAX_OUTPUT_CHARACTERS: ['tools', 'maxOutputCharacters'],
  JARVIS_TOOLS_MAX_OUTPUT_LINES: ['tools', 'maxOutputLines'],
  JARVIS_TOOLS_MAX_LINE_LENGTH: ['tools', 'maxLineLength'],
  JARVIS_TOOLS_TIMEOUT_MS: ['tools', 'timeoutMs'],
  JARVIS_TOOLS_MAX_GLOB_RESULTS: ['tools', 'maxGlobResults'],
  JARVIS_TOOLS_MAX_GREP_MATCHES: ['tools', 'maxGrepMatches'],
  JARVIS_TOOLS_MAX_READ_LINES: ['tools', 'maxReadLines'],
  JARVIS_TOOLS_EVENT_STORE_SIZE: ['tools', 'eventStoreSize'],
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

  const resolvedConfig = resolveProviderConfig(result.data)
  cachedConfig = resolvedConfig
  return resolvedConfig
}

function resolveProviderConfig(config: JarvisConfig): JarvisConfig {
  const providerKey = config.llm.provider === 'openai-compatible'
    ? 'openaiCompatible'
    : config.llm.provider

  const providerSettings = config.llm.providers[providerKey]
  const resolvedApiKey = config.llm.apiKey || providerSettings.apiKey
  const resolvedDefaultModel = config.llm.defaultModel || providerSettings.defaultModel
  const resolvedBaseUrl = config.llm.baseUrl ||
    providerSettings.baseUrl ||
    PROVIDER_DEFAULT_BASE_URLS[config.llm.provider]

  if (!resolvedApiKey) {
    throw new Error(`Missing API key for provider "${config.llm.provider}"`)
  }
  if (!resolvedBaseUrl) {
    throw new Error(`Missing base URL for provider "${config.llm.provider}"`)
  }
  if (!resolvedDefaultModel) {
    throw new Error(`Missing default model for provider "${config.llm.provider}"`)
  }

  try {
    new URL(resolvedBaseUrl)
  } catch {
    throw new Error(`Invalid base URL for provider "${config.llm.provider}": ${resolvedBaseUrl}`)
  }

  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey: resolvedApiKey,
      baseUrl: resolvedBaseUrl,
      defaultModel: resolvedDefaultModel,
    },
  }
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
      provider: config.llm.provider,
      apiKey: config.llm.apiKey ? '***set***' : '***NOT SET***',
      providers: {
        synthetic: {
          baseUrl: config.llm.providers.synthetic.baseUrl || '(default)',
          defaultModel: config.llm.providers.synthetic.defaultModel || '(unset)',
          apiKey: config.llm.providers.synthetic.apiKey ? '***set***' : '***NOT SET***',
        },
        minimax: {
          baseUrl: config.llm.providers.minimax.baseUrl || '(default)',
          defaultModel: config.llm.providers.minimax.defaultModel || '(unset)',
          apiKey: config.llm.providers.minimax.apiKey ? '***set***' : '***NOT SET***',
        },
        openaiCompatible: {
          baseUrl: config.llm.providers.openaiCompatible.baseUrl || '(default)',
          defaultModel: config.llm.providers.openaiCompatible.defaultModel || '(unset)',
          apiKey: config.llm.providers.openaiCompatible.apiKey ? '***set***' : '***NOT SET***',
        },
      },
    },
    telegram: {
      botToken: config.telegram.botToken ? '***set***' : '***NOT SET***',
      allowedUserIds: config.telegram.allowedUserIds,
    },
    memory: {
      enabled: config.memory.enabled,
      dir: config.memory.dir || '(default)',
      archiveRetentionDays: config.memory.archiveRetentionDays,
      summaryWindowMinutes: config.memory.summaryWindowMinutes,
      autoSummarize: config.memory.autoSummarize,
      autoContextMaxResults: config.memory.autoContextMaxResults,
      autoContextMaxTokens: config.memory.autoContextMaxTokens,
      searchMaxLimit: config.memory.searchMaxLimit,
      searchDefaultLimit: config.memory.searchDefaultLimit,
      recentDefaultLimit: config.memory.recentDefaultLimit,
      minSummaryTokens: config.memory.minSummaryTokens,
      tokenEstimationCharsPerToken: config.memory.tokenEstimationCharsPerToken,
    },
    logging: {
      level: config.logging.level,
      file: config.logging.file || '(none)',
    },
    history: {
      enabled: config.history.enabled,
      dbPath: config.history.dbPath,
      retentionHours: config.history.retentionHours,
      rehydrateMaxMessages: config.history.rehydrateMaxMessages,
    },
    workers: {
      searchPoolSize: config.workers.searchPoolSize,
      shellPoolSize: config.workers.shellPoolSize,
    },
    search: {
      provider: config.search.provider,
      defaultLimit: config.search.defaultLimit,
      maxLimit: config.search.maxLimit,
      timeoutMs: config.search.timeoutMs,
      brave: {
        baseUrl: config.search.brave.baseUrl,
        apiKey: config.search.brave.apiKey ? '***set***' : '***NOT SET***',
      },
      synthetic: {
        baseUrl: config.search.synthetic.baseUrl,
        apiKey: config.search.synthetic.apiKey ? '***set***' : '***NOT SET***',
      },
    },
    tools: {
      maxParallel: config.tools.maxParallel,
      maxIterations: config.tools.maxIterations,
      maxOutputCharacters: config.tools.maxOutputCharacters,
      maxOutputLines: config.tools.maxOutputLines,
      maxLineLength: config.tools.maxLineLength,
      timeoutMs: config.tools.timeoutMs,
      maxGlobResults: config.tools.maxGlobResults,
      maxGrepMatches: config.tools.maxGrepMatches,
      maxReadLines: config.tools.maxReadLines,
      eventStoreSize: config.tools.eventStoreSize,
    },
  }

  logger.info(safeConfig, 'Configuration loaded')
}
