# HAL Claude — Combined Agent Plan

## Philosophy

Take 9001's proven architecture (IPC, TUI, sessions, ASON) and rebuild it cleanly
with 9002's lessons (simplicity, right-sizing, safety). Tabs to spaces. Gitignored
ASON config files instead of `.env`. No cruft from day one.

## Architecture Overview

```
hal-claude/
├── main.ts                     # Entry point: owner election, CLI + web init
├── run                         # Restart loop (exit 100 = restart)
├── SYSTEM.md                   # System prompt (runtime-loaded, agent-editable)
├── AGENTS.md                   # Per-workdir agent customization
├── config.ason                 # Preferences: model, thresholds, UI (gitignored)
├── auth.ason                   # Tokens: provider creds, expiry (gitignored)
├── package.json                # Bun project with scripts
├── tsconfig.json
├── .gitignore
├── src/
│   ├── provider.ts             # Provider interface + registry
│   ├── providers/
│   │   ├── anthropic.ts        # Claude via OAuth
│   │   └── openai.ts           # OpenAI Responses API + Codex (one file, not two)
│   ├── auth.ts                 # Token refresh, provider init, auth.ason read/write
│   ├── config.ts               # config.ason read/write, defaults
│   ├── agent-loop.ts           # Stream → tool calls → repeat
│   ├── tools.ts                # Tool definitions + dispatch
│   ├── hashline.ts             # Content-addressed line editing
│   ├── prompt.ts               # SYSTEM.md + AGENTS.md loading, template interp
│   ├── session.ts              # Session load/save/handoff
│   ├── context.ts              # Token tracking, context bar display
│   ├── ipc.ts                  # File-backed bus (commands/events/state)
│   ├── protocol.ts             # IPC type defs (commands, events, state)
│   ├── runtime/
│   │   ├── sessions.ts         # Session cache + registry
│   │   ├── process-prompt.ts   # User input → agent loop
│   │   ├── process-command.ts  # Command routing
│   │   ├── command-scheduler.ts # Per-session FIFO + concurrency
│   │   └── event-publisher.ts  # Emit events to IPC
│   ├── cli/
│   │   ├── client.ts           # CLI event loop, tab management
│   │   ├── tui.ts              # Terminal scroll regions, footer, input
│   │   ├── keys.ts             # Key bindings
│   │   ├── format.ts           # ANSI formatting
│   │   └── commands.ts         # CLI-local commands
│   ├── web.ts                  # Debug web server + SSE (adapt from 9001)
│   ├── state.ts                # State dir paths
│   └── utils/
│       ├── ason.ts             # Copy from 9001 (battle-tested)
│       ├── ason.test.ts        # Copy from 9001
│       ├── is-pid-alive.ts     # Copy from 9001
│       └── tail-file.ts        # Copy from 9001
└── state/                      # Gitignored runtime data
    ├── ipc/
    │   ├── commands.ason
    │   ├── events.ason
    │   ├── state.ason
    │   └── owner.lock
    └── sessions/
        ├── index.ason
        └── s-{id}/
            ├── session.ason          # Full message history (single file)
            ├── session-previous.ason # Rotated on /handoff
            ├── handoff.md            # Written by /handoff for next session
            └── prompts.ason          # Append-only prompt log
```

## Key Design Decisions

### 1. Config split: `config.ason` + `auth.ason`

**config.ason** — preferences & settings (gitignored):
```ason
{
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    compactModel: 'claude-sonnet-4-20250514',
    contextWarnThreshold: 0.8,
    maxConcurrentSessions: 2,
}
```

**auth.ason** — credentials only (gitignored):
```ason
{
    anthropic: {
        accessToken: 'sk-ant-oat01-...',
        refreshToken: 'sk-ant-ort01-...',
        expires: 1771602009949,
    },
    openai: {
        accessToken: 'eyJ...',
        refreshToken: 'rt_...',
        expires: 1772057893848,
        accountId: 'cd485e06-...',
    },
}
```

Model lives in `config.ason` — it's a preference, not ephemeral state.
Runtime `/model` switches update `config.ason` so the choice persists across restarts.

### 2. Sessions: Single file + handoff
- `session.ason` — full message history, always
- No lean/full split (complexity not worth it)
- `/handoff` command:
  1. Model writes `handoff.md` (summary + what to do next)
  2. `session.ason` → `session-previous.ason`
  3. New session starts, reads `handoff.md` as context
  4. `session-previous.ason` stays for manual recovery
- On restart (exit 100): just reload `session.ason` as-is

### 3. Context management: Simple threshold + handoff
- Track tokens via bytes/4 heuristic (calibrate from first API response)
- Display braille context bar (from 9001)
- At 80%: warn user, suggest `/handoff`
- No auto-compaction. User decides when to hand off

### 4. OpenAI: One provider, not two
- Single `openai.ts` with endpoint resolution (Responses API vs Codex)
- Scope detection from JWT (like 9001)
- No copy-paste duplication

### 5. Edit tool: Hashline-only (from 9001, simplified)
- `read` returns lines as `42:xY4 function hello()` (line:hash content)
- `edit` takes `start_ref` + `end_ref` (e.g. `42:xY4`) to replace a range, or `after_ref` to insert
- Hash mismatch → error, forces re-read. This IS the safety mechanism.
- No separate string-matching mode. One tool, one mode, hashline refs only.
- Delete = replace with empty content

### 6. Prompt logging v2
- `state/sessions/<id>/prompts.ason` — append-only
- Each entry: `{ timestamp, model, provider, gitHash, prompt }`
- Gitignored, back-uppable

### 7. Code style
- Tabs (width 4) throughout
- No semicolons (Bun/TS standard)

## Implementation Phases

### Phase 1: Foundation (implement now)

**Copy as-is** (convert spaces→tabs):
- `src/utils/ason.ts` + `ason.test.ts`
- `src/utils/is-pid-alive.ts`
- `src/utils/tail-file.ts`

**Rewrite from scratch:**
1. `package.json`, `tsconfig.json`, `.gitignore`
2. `config.ason` + `src/config.ts` — preferences, defaults
3. `auth.ason` + `src/auth.ts` — credentials, token refresh
4. `src/provider.ts` — provider interface
5. `src/providers/anthropic.ts` — Claude with OAuth
6. `src/providers/openai.ts` — unified Responses API + Codex
7. `src/tools.ts` — tools with uniqueness check on edit
8. `src/hashline.ts` — content-addressed editing
9. `src/agent-loop.ts` — stream → tool calls → repeat
10. `src/prompt.ts` — SYSTEM.md + template interpolation
11. `src/session.ts` — session load/save/handoff
12. `src/context.ts` — token tracking + braille bar
13. `src/state.ts` — state directory paths
14. `src/protocol.ts` — IPC types
15. `src/ipc.ts` — file-backed bus
16. `src/runtime/` — sessions, process-prompt, process-command, scheduler, publisher
17. `src/cli/` — TUI client with tabs
18. `src/web.ts` — debug web server (adapt from 9001)
19. `main.ts` — entry point
20. `run` — restart script
21. `SYSTEM.md` — system prompt

### Phase 2: Polish (soon after)
- Login scripts for OAuth flows
- Mock provider for testing
- Tool call logging to `state/tool-calls.ason`
- Port conflict recovery
- Web search tool results passthrough

### Phase 3: Future
- Better web UI (separate project)
- Tool approval flow
- AGENTS.md per-workdir loading
- Multiple concurrent sessions

## Tests (minimal, manual)
- `bun test src/utils/ason.test.ts` — ASON serialization
- Manual: start agent, send prompt, verify streaming
- Manual: `/handoff`, verify rotation + handoff.md
- Manual: kill + restart, verify session restored
- Manual: open second terminal, verify IPC attach
- Manual: switch tabs, verify multi-session

## Migration
1. Copy tokens from `.hal9001/.env` → `auth.ason`
2. Set preferences in `config.ason`
3. Write fresh `SYSTEM.md`
