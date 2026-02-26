# Configuration System

Jarvis now uses a centralized JSON-based configuration system. All configuration is loaded from `.config/default.json` and environment variables are mapped through the configuration layer.

## Configuration File

The main configuration file is located at `.config/default.json`:

```json
{
  "llm": {
    "provider": "synthetic",
    "defaultModel": "hf:nvidia/Kimi-K2.5-NVFP4",
    "providers": {
      "synthetic": {
        "apiKey": "your-synthetic-api-key-here",
        "baseUrl": "https://api.synthetic.new/openai/v1",
        "defaultModel": "hf:nvidia/Kimi-K2.5-NVFP4"
      },
      "minimax": {
        "apiKey": "your-minimax-api-key-here",
        "baseUrl": "https://api.minimax.io/v1",
        "defaultModel": "MiniMax-M2.5"
      },
      "openaiCompatible": {
        "apiKey": "",
        "baseUrl": "",
        "defaultModel": ""
      }
    }
  },
  "telegram": {
    "botToken": "your-bot-token-here",
    "allowedUserIds": []
  },
  "memory": {
    "enabled": true,
    "dir": "",
    "summaryWindowMinutes": 30,
    "autoSummarize": false
  },
  "logging": {
    "level": "info",
    "file": ""
  },
  "workers": {
    "searchPoolSize": 2,
    "shellPoolSize": 3
  },
  "tools": {
    "maxParallel": 5
  }
}
```

## Environment Variable Mapping

Environment variables are automatically mapped to configuration values. Create `.env` file or set environment variables:

| Environment Variable | Config Path |
|---------------------|-------------|
| `LLM_PROVIDER` | `llm.provider` |
| `SYNTHETIC_API_KEY` | `llm.providers.synthetic.apiKey` |
| `SYNTHETIC_BASE_URL` | `llm.providers.synthetic.baseUrl` |
| `SYNTHETIC_DEFAULT_MODEL` | `llm.providers.synthetic.defaultModel` |
| `MINIMAX_API_KEY` | `llm.providers.minimax.apiKey` |
| `MINIMAX_BASE_URL` | `llm.providers.minimax.baseUrl` |
| `MINIMAX_DEFAULT_MODEL` | `llm.providers.minimax.defaultModel` |
| `OPENAI_API_KEY` | `llm.providers.minimax.apiKey` (alias) |
| `OPENAI_BASE_URL` | `llm.providers.minimax.baseUrl` (alias) |
| `OPENAI_COMPATIBLE_API_KEY` | `llm.providers.openaiCompatible.apiKey` |
| `OPENAI_COMPATIBLE_BASE_URL` | `llm.providers.openaiCompatible.baseUrl` |
| `OPENAI_COMPATIBLE_DEFAULT_MODEL` | `llm.providers.openaiCompatible.defaultModel` |
| `LLM_API_KEY` | `llm.apiKey` (override active provider key) |
| `LLM_BASE_URL` | `llm.baseUrl` (override active provider URL) |
| `DEFAULT_MODEL` | `llm.defaultModel` (override active provider model) |
| `TELEGRAM_BOT_TOKEN` | `telegram.botToken` |
| `TELEGRAM_ALLOWED_USER_IDS` | `telegram.allowedUserIds` |
| `JARVIS_MEMORY_DIR` | `memory.dir` |
| `JARVIS_MEMORY_SUMMARY_WINDOW_MINUTES` | `memory.summaryWindowMinutes` |
| `JARVIS_AUTO_SUMMARIZE` | `memory.autoSummarize` |
| `JARVIS_LOG_LEVEL` | `logging.level` |
| `JARVIS_LOG_FILE` | `logging.file` |

## Priority Order

Configuration values are resolved in this priority (highest to lowest):

1. CLI flags (e.g., `-m`, `--model`)
2. Environment variables (via `.env` file or shell)
3. Configuration file (`.config/default.json`)
4. Default values

## Migration from .env

If you were previously using `.env` file, simply ensure the same variables are set. The configuration system will read them automatically.

Example `.env`:
```bash
LLM_PROVIDER=minimax
MINIMAX_API_KEY=your-key
MINIMAX_DEFAULT_MODEL=MiniMax-M2.5
TELEGRAM_BOT_TOKEN=your-token
JARVIS_AUTO_SUMMARIZE=false
```

## Validation

Configuration is validated on startup using Zod schemas. If validation fails, the application will exit with an error message explaining what's wrong.

## Example Usage

```typescript
import { getConfig } from './config.ts'

async function main() {
  const config = await getConfig()
  
  // Use typed config values
  console.log(config.llm.defaultModel)
  console.log(config.memory.enabled)
  console.log(config.tools.maxParallel)
}
```

## Changes Made

- Removed `dotenv` dependency
- Removed all `process.env` direct access
- Configuration is now the single source of truth
- All configuration goes through `getConfig()`
- Type-safe with full TypeScript support
