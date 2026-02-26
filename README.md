# Jarvis

An AI assistant and digital familiar inspired by J.A.R.V.I.S. (Just A Rather Very Intelligent System) from the Marvel Universe—the iconic digital assistant of Tony Stark.

## About This Project

Jarvis is being built **incrementally and deliberately**. This is not a code knockout project with one giant PR. Instead, we're constructing it piece by piece, using it along the way as a learning platform and experimentation ground.

### Guiding Principles

- **Incremental Development**: Small, focused additions that can be tested and validated before moving forward
- **Learning-First**: Each component is an opportunity to explore new technologies and patterns
- **Pragmatic**: Build what works, discard what doesn't, iterate based on real usage

## Requirements

- **Node.js v22+** (uses native TypeScript execution via `--experimental-strip-types`)
- A [synthetic.new](https://synthetic.new/) API key

## Getting Started

```bash
# Install dependencies
npm install

# Copy env file and configure
cp .env.example .env
# Edit .env — add your SYNTHETIC_API_KEY and DEFAULT_MODEL
```

## Usage

### CLI Chat

```bash
# Simple chat
jarvis chat "What is the capital of France?"

# Stream the response
jarvis chat "Explain quantum computing" --stream

# Chat with tool calling (file read, grep, shell, etc.)
jarvis chat-with-tools "Read README.md and summarize it"

# Specify model and temperature
jarvis chat "Hello" -m "hf:model-name" -t 0.9

# Read prompt from a file
jarvis chat --file ./prompt.txt

# List available models
jarvis list-models
```

### Telegram Bot

Jarvis can run as a Telegram bot using long-polling — no public URL or server infrastructure required.

**Setup:**

1. Message [@BotFather](https://t.me/BotFather) on Telegram and create a new bot
2. Copy the bot token and add it to your `.env`:
   ```
   TELEGRAM_BOT_TOKEN=your-token-here
   ```
3. Start the bot:
   ```bash
   jarvis telegram
   ```

**Options:**

```bash
jarvis telegram                          # uses DEFAULT_MODEL from .env
jarvis telegram -m "hf:model-name"       # specify model
jarvis telegram -s "You are a pirate"    # custom system prompt
jarvis telegram --log-file ./bot.log     # write logs to file
```

**In-chat commands:**

- Send any text message to chat with the LLM
- `/clear` — reset conversation history

The bot maintains per-chat conversation history in memory (resets on restart). Long responses are automatically split across multiple messages.

## Roadmap

The vision for Jarvis includes (in no particular order):

- Voice interaction and natural language understanding
- System integration and automation
- Context-aware assistance
- Learning and personalization
- Cross-platform accessibility
- Security and privacy-first design

## Contributing

This is a personal project, but feedback and ideas are welcome.

## License

MIT

