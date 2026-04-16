# Jork

Solana's Autonomous Build Engine.

Jork makes building on Solana as simple as sending a message.  Anyone with an idea can become a builder overnight - no deep technical skills needed. Just describe what you want, by text or voice on Telegram, and Jork handles the rest: scaffolding, coding, testing, deploying. More builders means more apps, more consumers, and faster growth for the Solana ecosystem.

## What she does

Build anything on Solana. Tokens, NFTs, DeFi protocols, full-stack dapps, games, DAOs, Blinks, marketplaces - literally anything. Simple or complex. Your imagination is the limit.

- Shows you a plan before building, then executes step by step
- Each step is verified before moving to the next
- Understands voice messages and images
- Learns about you over time (deployment preferences, frameworks, workflow)
- Remembers every conversation with intelligent recall
- Works with any AI provider - no vendor lock-in

## Requirements

- Node.js 18+
- A Telegram account
- One of: Anthropic API key, Z.AI/GLM key, OpenAI key, or Gemini key

## Install

### One-liner (replace with your actual keys)

```bash
git clone https://github.com/hirodefi/Jork && cd Jork && npm install && npm run setup TELEGRAM_ID BOT_TOKEN AI_PROVIDER API_KEY
```

| Parameter | What it is | How to get it |
|-----------|-----------|---------------|
| `TELEGRAM_ID` | Your numeric Telegram user ID | Message @userinfobot on Telegram |
| `BOT_TOKEN` | Your Telegram bot token | Message @BotFather, send /newbot |
| `AI_PROVIDER` | `anthropic` `glm` `openai` `gemini` | Pick one |
| `API_KEY` | Your provider's API key | See provider links below |

Or run interactive setup (step-by-step prompts):

```bash
git clone https://github.com/hirodefi/Jork && cd Jork && npm install && npm run setup
```

## Before you run setup

You need three things ready.

### 1. Your Telegram user ID

Your personal numeric ID - not your username, not a bot. Just a number like `123713022`.

- Open Telegram and message **@userinfobot**
- It replies with your ID instantly
- Copy that number - you will paste it into setup

### 2. A Telegram bot token

Jork needs her own bot to talk through.

- Open Telegram and message **@BotFather**
- Send `/newbot`
- Pick a name (e.g. "Jork") and a username (e.g. `myjorkbot`)
- BotFather gives you a token that looks like `1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ`
- Copy that token - you will paste it into setup
- Then open your new bot in Telegram and press Start (so it can message you)

### 3. An AI provider

Pick one:

| Provider | How to get | Notes |
|----------|-----------|-------|
| Claude API | https://console.anthropic.com | Anthropic's API with tool use |
| GLM (Z.AI) | https://z.ai | Zhipu AI, Anthropic-compatible, tool use supported |
| OpenAI | https://platform.openai.com | GPT-4o and compatible |
| Gemini | https://aistudio.google.com | Google AI |

## Architecture

```
src/
  jork.js           - Router, handlers, build pipeline
  engine/
    loop.js         - Agentic tool-use loop (provider-independent)
    tools.js        - 8 tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
    providers.js    - Anthropic/Z.AI + OpenAI/Gemini adapters
    session.js      - Conversation state management
  llm.js            - LLM abstraction (4 providers)
  telegram.js       - Telegram interface (text, voice, images)
  config.js         - Configuration and paths
```

Jork's knowledge lives in her nucleus:

```
nucleus/
  SELF.md           - Who she is. Evolves over time.
  SOLANA.md         - Solana knowledge brain. Section-indexed, self-updating.
  COFOUNDER.md      - Co-founder profile. Learns about you over time.
  SNAPSHOT.md       - Current project state
  goals.json        - Active goals with steps
```

### Execution Engine

Jork has her own execution engine (src/engine/). No external CLI dependency. The engine:

1. Sends prompts + tool definitions to any LLM API
2. When the LLM requests tool calls, executes them locally (bash, file ops, web)
3. Sends results back, loops until done

Works with any provider that supports tool calling: Anthropic, Z.AI/GLM, OpenAI, Gemini.

### Message Router

Messages are classified before processing:

- **Commands** (stop, cancel, status, show/hide thinking) - instant, no LLM call
- **Chat** - lightweight context (~3KB), natural response
- **Build** - full context (~15KB), structured plan + step-by-step execution

SOLANA.md is loaded by section (keyword-indexed), not dumped entirely. Chat about tokens loads the "SPL Tokens" section, not all 440 lines.

### Build Pipeline

When you ask Jork to build something:

1. She creates a plan (3-6 steps, plain English) and shows it to you
2. Each step runs as a separate, focused execution (30 turns max per step)
3. Each step is verified before moving to the next
4. Failed steps retry once with error context, then surface as a blocker
5. Final result includes only verified URLs

## Powers

5 powers ship by default. All installed automatically on setup.

| Power | What it does |
|-------|-------------|
| memory | Conversation recall with keyword indexing, concept classification, synonym expansion, and recency-weighted search |
| solana | Full toolchain: scaffold, build, test, deploy, wallet, tokens, tx-history, account-info, diagnose (30+ errors), deploy-verify |
| web2 | Server setup: nginx (proxy, SPA, API+frontend), SSL, SSH, Vercel/SSH deploy, PM2, MongoDB, deploy checklist, firewall |
| voice | Transcribe voice messages using Whisper tiny with Solana term correction |
| image | Read and analyze images via AI vision |

### Extended powers

More powers at https://github.com/hirodefi/Jork-Powers:

| Power | What it does |
|-------|-------------|
| research | Deep web research: DuckDuckGo, Brave, Wikipedia, HackerNews, arXiv, GitHub |
| news | Real-time news from RSS feeds (crypto, tech, general) |
| reddit | Search and read Reddit without API key |
| x-search | Search X/Twitter via Nitter |
| earn | ClawTasks bounties, Reddit pain mining, digital product strategies |
| private-ip | Tor IP rotation for anonymous requests |

## Usage

Once running, message Jork on Telegram. Text or voice.

### Built-in commands

| Say | What it does |
|-----|-------------|
| `show thinking` | Show Jork's progress as she builds (hidden by default) |
| `hide thinking` | Hide progress, show only final result |
| `stop` / `cancel` | Stop the current build task |
| `status` | Check what Jork is working on (instant, no LLM) |

### How Jork works

When you give Jork a build task, she shows you a plan first. Once confirmed, she executes each step, verifies it worked, and moves to the next. You can message her anytime during the build. New build requests get queued. Chat and questions get a reply right away.

- "Build me a full DEX with liquidity pools and a swap UI"
- "Create a token-gated membership platform with governance voting"
- "I want an NFT collection with a minting page, 10k supply, reveal mechanic"
- "Build a lending protocol with collateral, interest rates, and liquidation"
- "Set up a React frontend with wallet connect, deploy it to Vercel"
- "Create a Solana program that escrows SOL between two parties"
- Send a voice message describing what you want to build
- Send a screenshot of an error, a UI mockup, or architecture diagram

## Running

```bash
npm start                          # run directly
pm2 start ecosystem.config.js     # run with PM2 (recommended)
pm2 logs jork                     # view logs
```

## License

MIT
