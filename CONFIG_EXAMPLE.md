# Configuration System Example

This is a thin slice demonstrating the new configuration system using **c12** + **Zod**.

## What Was Built

### Files Created

1. **`.config/default.json`** - Default configuration values
   - LLM settings (model, API key, base URL)
   - Telegram settings (bot token, allowed users)
   - Memory settings (enabled, directory, window, auto-summarize)
   - Logging settings (level, file)
   - Worker pool sizes (search, shell)
   - Tool settings (max parallel)

2. **`.config/custom-environment-variables.json`** - Documents env var mappings

3. **`src/config.ts`** - Configuration loader with Zod validation
   - Loads JSON config using c12
   - Merges environment variables
   - Validates with Zod schemas
   - Provides typed `JarvisConfig` interface
   - Caches config for performance

4. **`src/config-example.ts`** - Example demonstrating usage

### How It Works

1. **Configuration Hierarchy** (lowest to highest priority):
   - `.config/default.json` - Base defaults
   - `.config/{development,production}.json` - Environment-specific overrides
   - Environment variables - Runtime overrides
   - CLI flags - Per-command overrides

2. **Environment Variable Mapping**:
   ```
    LLM_PROVIDER → config.llm.provider
    SYNTHETIC_API_KEY → config.llm.providers.synthetic.apiKey
    SYNTHETIC_DEFAULT_MODEL → config.llm.providers.synthetic.defaultModel
    MINIMAX_API_KEY → config.llm.providers.minimax.apiKey
    MINIMAX_DEFAULT_MODEL → config.llm.providers.minimax.defaultModel
    OPENAI_API_KEY → config.llm.providers.minimax.apiKey (alias)
    OPENAI_BASE_URL → config.llm.providers.minimax.baseUrl (alias)
    DEFAULT_MODEL → config.llm.defaultModel (global override)
   TELEGRAM_BOT_TOKEN → config.telegram.botToken
   TELEGRAM_ALLOWED_USER_IDS → config.telegram.allowedUserIds
   JARVIS_MEMORY_DIR → config.memory.dir
   JARVIS_LOG_LEVEL → config.logging.level
   ...and more
   ```

3. **Type Safety**:
   - Zod schemas validate all config values
   - TypeScript types inferred from schemas
   - Transformations handle string→number, string→boolean, etc.

## Running the Example

```bash
# Load defaults from JSON
node --experimental-strip-types src/config-example.ts

# Override with environment variables
DEFAULT_MODEL=hf:custom-model SYNTHETIC_API_KEY=secret node --experimental-strip-types src/config-example.ts

# With existing .env file (dotenv auto-loads)
node --experimental-strip-types src/config-example.ts
```

## Next Steps to Fully Integrate

1. **Update cli.ts** to use `getConfig()` instead of `process.env` directly
2. **Update llm/client.ts** to read from config
3. **Update memory/db.ts** to use config.memory.dir
4. **Update logger.ts** to use config.logging
5. **Remove dotenv** dependency (optional - c12 + env vars replace it)
6. **Add validation** for required fields (e.g., SYNTHETIC_API_KEY)

## Benefits

- ✅ **Type-safe** - Full TypeScript support with Zod validation
- ✅ **Environment-specific** - Different configs for dev/prod
- ✅ **Environment variables** - 12-factor app compatible
- ✅ **JSON-based** - Easy to read and version control
- ✅ **No secrets in JSON** - Sensitive data via env vars only
- ✅ **Validation** - Clear error messages on misconfiguration
- ✅ **Caching** - Config loaded once, reused throughout app

## Dependencies Added

```json
{
  "dependencies": {
    "c12": "^...",
    "zod": "^...",
    "jiti": "^..."
  }
}
```

- `c12` - Configuration loader with file/env merging
- `zod` - Schema validation and type inference
- `jiti` - Required for loading JSON/TypeScript configs
