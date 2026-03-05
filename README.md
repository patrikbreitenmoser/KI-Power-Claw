# KI Power Claw

```text
██╗  ██╗██╗    ██████╗  ██████╗ ██╗    ██╗███████╗██████╗
██║ ██╔╝██║    ██╔══██╗██╔═══██╗██║    ██║██╔════╝██╔══██╗
█████╔╝ ██║    ██████╔╝██║   ██║██║ █╗ ██║█████╗  ██████╔╝
██╔═██╗ ██║    ██╔═══╝ ██║   ██║██║███╗██║██╔══╝  ██╔══██╗
██║  ██╗██║    ██║     ╚██████╔╝╚███╔███╔╝███████╗██║  ██║
╚═╝  ╚═╝╚═╝    ╚═╝      ╚═════╝  ╚══╝╚══╝ ╚══════╝╚═╝  ╚═╝
 ██████╗██╗      █████╗ ██╗    ██╗
██╔════╝██║     ██╔══██╗██║    ██║
██║     ██║     ███████║██║ █╗ ██║
██║     ██║     ██╔══██║██║███╗██║
╚██████╗███████╗██║  ██║╚███╔███╔╝
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
```

Personal Telegram assistant that runs Claude Code locally on your machine.  
It supports chat, file/media input, scheduled tasks, background subagents, and a file-based memory system with QMD search.

## Features

- Telegram bot with local Claude Code execution (`@anthropic-ai/claude-agent-sdk`)
- Persistent chat sessions per Telegram chat
- Background subagents (trigger by writing "in the background" or via `SUBAGENT` blocks)
- Scheduler for recurring tasks (cron)
- Voice note transcription via Groq Whisper (STT)
- Media/document/video passthrough workflows
- Persona system via `SOUL.md`, `USER.md`, `IDENTITY.md`
- File-based memory:
  - `memory/MEMORY.md` for long-term memory (always loaded)
  - `memory/YYYY-MM-DD.md` daily logs
  - QMD retrieval over memory files
  - Nightly consolidation into long-term memory
  - Hot/cold curation with demotion when memory gets too large

## Requirements

- Node.js `>= 20`
- Claude Code CLI installed and logged in (`claude --version`)
- QMD CLI (`qmd`) installed and available in `PATH` (install: [tobi/qmd](https://github.com/tobi/qmd))
- Telegram bot token from `@BotFather`

Optional:
- Groq API key for voice transcription
- Gemini API key for Gemini-based workflows. Set one alias: `GEMINI_API_KEY` or `GOOGLE_API_KEY` (same key, only one needed). Used for video analysis and Gemini image skills (e.g. `nanobana`)

## Quick Start

```bash
npm install
npm run setup
```

The setup wizard walks you through everything: bot token, API keys, persona, chat ID capture, QMD memory setup, and background service installation.

**First-time memory setup:**

```bash
cp memory/MEMORY.example.md memory/MEMORY.md
```

Edit `memory/MEMORY.md` to add your personal information, preferences, and projects.

<details>
<summary>Manual setup (without wizard)</summary>

1. `npm install`
2. `npm run build`
3. `cp .env.example .env` and fill in `TELEGRAM_BOT_TOKEN` and `ALLOWED_USER_IDS`
   - If `ALLOWED_USER_IDS` is left empty, the first private user who messages the running bot is registered automatically and the bot locks to that user.
4. Set up QMD for memory search:
   ```bash
   qmd collection add ./memory --name bot-memory --mask "**/*.md"
   qmd update && qmd embed
   ```
5. `npm start`

</details>

### Dev mode

```bash
npm run dev
```

## Environment Variables

From `.env.example`:

- `TELEGRAM_BOT_TOKEN` (required)
- `ALLOWED_USER_IDS` (optional; if empty, the first private user to message the running bot is registered automatically)
- `GROQ_API_KEY` (optional, voice STT)
- `GEMINI_API_KEY` / `GOOGLE_API_KEY` (optional aliases for the same Gemini API key; set one). Used for video analysis and Gemini image workflows/skills (e.g. `nanobana`)
- `LOG_LEVEL` (optional, default `info`)
- `AGENT_TRACE_MODE` (optional, `off|errors|full`, default `off`)
- `AGENT_TRACE_RETENTION_DAYS` (optional, default `14`)
- `AGENT_TRACE_DIR` (optional, default `store/agent-trace`)

Also supported by runtime:

- `DEFAULT_MODEL` (optional, default `claude-sonnet-4-6`)

Env handling:

- Keys in `.env` are forwarded to the Claude agent subprocess.
- For Gemini tooling/skills, setting one alias in `.env` is enough (`GEMINI_API_KEY` or `GOOGLE_API_KEY`). Shell `export` is optional.

## Telegram Commands

- `/start` show welcome
- `/chatid` show your Telegram chat ID
- `/newchat` clear current Claude session
- `/forget` alias for `/newchat`
- `/memory` show memory stats and recent entries
- `/consolidate` run memory consolidation now
- `/model` view/set model override
- `/schedule` manage scheduled tasks
- `/agents` inspect/cancel background agents

Notes:
- Voice notes are transcribed if `GROQ_API_KEY` is set.
- There is currently no TTS voice reply mode.

## Memory System

### Storage

- `memory/MEMORY.md`: long-term hot memory, always included in context
  - **First use:** Copy `memory/MEMORY.example.md` to `memory/MEMORY.md` and customize
  - This file is gitignored - your personal memory stays local
- `memory/YYYY-MM-DD.md`: daily conversation logs
- `memory/archive/`: archived daily logs after consolidation
- `memory/cold/`: demoted memory entries (still searchable via QMD)
- `memory/memory_index.json`: scoring metadata for curation
- `store/agent-trace/YYYY-MM-DD.jsonl`: optional per-run agent traces (`AGENT_TRACE_MODE`)

### Retrieval

When a message comes in:

1. Load full `MEMORY.md`
2. Run `qmd search` for relevant snippets
3. Exclude `MEMORY.md` hits from QMD results (avoid duplicates)
4. Inject `[Long-term memory]` and `[Relevant past context]` into prompt

### Consolidation

Runs:
- On startup (catch-up)
- Nightly at 23:00 Europe/Zurich
- Manually via `/consolidate`

Flow:

1. Read eligible daily logs (excluding today)
2. Extract fact bullets via Claude Code SDK (tools disabled)
3. Classify facts into memory sections (DE/EN keyword rules)
4. Deduplicate exact lines and write to `MEMORY.md`
5. Archive processed daily logs
6. Enforce hot memory size:
   - hard cap: 200 lines
   - target after compaction: 180 lines
   - low-score entries are demoted to `memory/cold/*.md`

## Background Subagents

- User can request background execution by including phrases like `"in the background"`.
- Bot persists subagent runs in SQLite (`subagents` table).
- `/agents` shows recent runs and details.
- `/agents cancel <id>` cancels running subagents.

## Scheduler

Scheduler polls every 60s and executes due tasks from SQLite (`scheduled_tasks`).

CLI:

```bash
npm run schedule -- list
npm run schedule -- create "Summarize open tasks" "0 9 * * *" <chat_id>
npm run schedule -- pause <id>
npm run schedule -- resume <id>
npm run schedule -- delete <id>
```

## Scripts

- `npm run setup` interactive setup
- `npm run status` runtime/config status overview
- `scripts/notify.sh "message"` send Telegram message to first allowed user

## Project Structure

```text
src/
  index.ts            bootstrap + lifecycle
  bot.ts              Telegram handlers + commands
  agent.ts            Claude agent wrapper
  subagent.ts         background subagent orchestration
  scheduler.ts        recurring task runner
  schedule-cli.ts     scheduler CLI
  memory.ts           memory retrieval + daily logging
  agent-trace.ts      optional JSONL trace writer for agent runs
  qmd.ts              QMD wrapper (search/reindex/health)
  consolidation.ts    nightly memory consolidation + hot/cold curation
  db.ts               SQLite schema + CRUD
  media.ts            media download + prompt builders
  voice.ts            Groq Whisper transcription
  persona.ts          SOUL/USER/IDENTITY loading
```

## Quality Checks

```bash
npm run typecheck
npm run build
npm test
```

`npm test` currently requires test files to exist.
