# Jork

**Autonomous AI framework for anyone with an idea.**

Jork removes the barrier between having an idea and building something real. No coding skills. No team. No heavy subscriptions. Just a text message.

You describe what you want. Jork handles the rest — research, outreach, operations, development, deployment. Continuously. Autonomously. Around the clock.

---

## What Jork Does

Jork is not a chatbot or a code generator. It is an autonomous operating system for ideas.

Tell Jork what you are building. It assembles the right agents, sets them to work, and manages the entire operation — without you needing to manage it. Each agent handles a specific function: research, communication, content, development, quality, monitoring. They run in parallel, coordinate with each other, and report back to you.

The result is a working, operating business function — not a draft, not a suggestion, not a plan. Something actually running.

---

## Live Proof

Jork is not theoretical. A live instance is running at **[jork.online](https://jork.online)**, powering the entire marketing and client acquisition operation of a Google News-verified UK news publication.

That instance:
- Scans 12 platforms continuously for potential clients
- Researches and scores each prospect
- Writes personalised outreach for each contact
- Sends messages across email, LinkedIn, Instagram, and other channels
- Reads replies, interprets intent, responds appropriately
- Manages the full conversation from first contact to conversion

**Results in the first 16 days of commercial operation: 15 paying clients, £1,400+ in revenue. Zero manual outreach.**

---

## Who It Is For

Anyone with an idea.

- A student who wants to launch something but has no technical background
- A graduate who wants to build a business but cannot afford a team
- An entrepreneur who needs their marketing to run while they focus on building
- A founder who wants to scale operations without scaling headcount

If you have an idea and a phone, Jork is for you.

---

## How It Works

Jork runs on Telegram. You text it — or voice message it — and it goes to work.

```
You: I want to find clients for my design studio. Target early-stage startups.

Jork: On it. I'll scan Product Hunt, LinkedIn, and press wires for companies 
      that launched in the last 30 days, score them for fit, and start outreach 
      today. I'll keep you posted on replies.
```

No setup wizard. No configuration forms. No technical knowledge required. A conversation is enough to start.

---

## Architecture

Jork is built on a provider-independent agentic engine with a modular powers system.

```
src/
  jork.js          — Core router, handlers, agent pipeline
  engine/
    loop.js        — Agentic tool-use loop (provider-independent)
    tools.js       — Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
    providers.js   — Anthropic, GLM, OpenAI, Gemini adapters
    session.js     — Conversation state and memory management
    index.js       — Engine entry point
  llm.js           — LLM abstraction (5 providers, zero lock-in)
  config.js        — Paths and configuration
  telegram.js      — Telegram interface (text, voice, image)

nucleus/
  SELF.md          — Jork's identity and operating principles
  SNAPSHOT.md      — Current state and active context
  goals.json       — Active goals with progress tracking

Powers (modular capability system):
  memory           — Persistent recall across all conversations
  web2             — Server operations, nginx, SSL, SSH, PM2, deployment
  voice            — Whisper-based voice transcription
  image            — Vision input processing
```

### Key Design Principles

**Provider independence** — Jork works with Anthropic, GLM, OpenAI, or Gemini. Switch providers without changing anything else.

**Modular powers** — Capabilities are installed as self-contained modules. Add a new power and every Jork instance gains the capability immediately.

**Autonomous operation** — Jork does not wait to be asked. It runs continuously, checks in when needed, and handles the loop from task to completion without hand-holding.

**Accessible by design** — The interface is Telegram. The access point is a text message. No app store. No account dashboard. No configuration required.

---

## Install

```bash
git clone https://github.com/hirodefi/Jork && cd Jork && npm install && npm run setup
```

**Requirements:**
- Node.js 18+
- A Telegram account and bot token ([@BotFather](https://t.me/BotFather))
- One AI provider key: Anthropic, GLM, OpenAI, or Gemini

**Setup will ask for:**

| Parameter | What it is |
|-----------|------------|
| `TELEGRAM_ID` | Your numeric Telegram user ID — message [@userinfobot](https://t.me/userinfobot) |
| `BOT_TOKEN` | Your Telegram bot token from @BotFather |
| `AI_PROVIDER` | `anthropic` / `glm` / `openai` / `gemini` |
| `API_KEY` | Your chosen provider's API key |

---

## Roadmap

- **Hosted platform** — No self-hosting required. Text a number, get a running Jork instance.
- **Phone-first onboarding** — Start with a text message, no signup, no app download
- **Expanded powers** — More platform integrations, more autonomous capabilities
- **University and accelerator access** — Making Jork available to students and early-stage founders across the UK

---

## Built by

[hirodefi](https://github.com/hirodefi) — builder and writer, working across technology and independent media.

---

*Jork is open source. The hosted platform is coming.*
