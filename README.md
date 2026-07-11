# Jork

**Autonomous AI agent for anyone with an idea.**

Jork removes the barrier between having an idea and building something real. No coding skills. No team. No heavy subscriptions. Just a text message.

You describe what you want. Jork builds it, end to end, on its own.

---

## What Jork Does

Jork can build things. Applications, tools, programs, whatever you describe, it writes the code, tests it, and ships it, without you needing to know how any of that works.

You bring the idea. Jork brings the execution.

---

## Live Proof

Jork is not theoretical. A live instance is running at **[jork.online](https://jork.online)**, operating a real project continuously, with no manual intervention.

---

## Who It Is For

Anyone with an idea.

- A student who wants to build something but has no technical background
- A graduate who wants to launch a project but cannot afford a team
- An entrepreneur who has an idea and nothing else to build it with
- Anyone who wants to go from idea to working product without learning to code first

If you have an idea and a phone, Jork is for you.

---

## How It Works

Jork runs on Telegram. You text it, or voice message it, and it goes to work.

```
You: I want to build an app that does X.

Jork: On it. I'll scope it, build it, test it, and let you know when it's ready.
```

No setup wizard. No configuration forms. No technical knowledge required. A conversation is enough to start.

---

## Architecture

Jork is built on a provider-independent agentic engine with a modular powers system.

```
src/
  jork.js          — Core router, handlers, build pipeline
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
- **Expanded powers** — More capabilities, more autonomous reach
- **Wider access** — Making Jork available to more builders, everywhere

---

## Built by

[hirodefi](https://github.com/hirodefi)

---

*Jork is open source. The hosted platform is coming.*
