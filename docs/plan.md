# Rewrite Plan — March 2026

Previous codebase: 12,362 lines (over budget). Current: 2,985. Budget: 10,000.

## Status: What We Have (2,985 lines)

| Area | Lines | Files |
|---|---|---|
| CLI/UI | 1,544 | prompt, keys, blocks, md, colors, render, cli, clipboard |
| Utils | 717 | ason, strings, live-file, tail-file, oklch |
| Top-level | 438 | client, main, ipc, config, state |
| Session | 77 | sessions |
| Server | 79 | runtime (stub) |
| Perf | 32 | perf |
| Providers | 0 | — |
| Tools | 0 | — |
| MCP | 0 | — |

198 tests passing.

---

## 1. CLI/UI — Remaining (~+350 lines, cumulative: ~3,335)

### 1a. Completion (+150)
Tab completion for /commands, model names, file paths. Port from previous
`completion.ts` (210 lines) — simplify, reuse prompt module for display.
- `cli/completion.ts` ~120 lines
- Wire into `cli/keys.ts` ~30 lines

### 1b. Help bar (+50)
Bottom status bar showing context-sensitive keybindings.
- `cli/help-bar.ts` ~50 lines
- Wire into `render.ts` ~5 lines

### 1c. Tool output formatting (+80)
Bash/read/write output display: syntax-aware truncation, line numbers,
diff-style coloring for write/edit.
- Expand `blockContent()` in `blocks.ts` ~60 lines
- Command status indicators (spinner, elapsed, exit code) ~20 lines

### 1d. Polish (+70)
- Queue indicator when messages are pending ~20 lines
- Key usage display (token/cost) in status line ~30 lines
- Draft save/restore on tab switch ~20 lines

**Cumulative after CLI/UI: ~3,335**

---

## 2. Runtime/Agent (+1,100 lines, cumulative: ~4,435)

### 2a. Agent loop (+350)
The core: read command, build messages, call provider, stream response,
handle tool_use, repeat. Previous was 403 lines — same ballpark, single file.
- `runtime/agent-loop.ts` ~350 lines

### 2b. Commands (+250)
Slash commands: /model, /clear, /fork, /compact, /cd, /show, /help, /exit, etc.
Previous was 301 lines.
- `runtime/commands.ts` ~250 lines

### 2c. Context builder (+150)
Build the system prompt + conversation messages from history. AGENTS.md loading,
context window management, token counting. Previous: context.ts 180 + system.ts 402.
Merge and simplify.
- `runtime/context.ts` ~150 lines

### 2d. Startup + runtime glue (+100)
Replace the echo stub. Wire agent loop to IPC. Handle restarts, interrupts.
Previous: startup.ts 243 + runtime.ts 244. Heavy overlap — merge.
- Expand `server/runtime.ts` from 79 → ~180 lines

### 2e. Protocol (+80)
Shared types for IPC events and commands. Previous was 166 lines — many
types unused. Trim to what we need.
- `protocol.ts` ~80 lines

### 2f. Models (+100)
Model registry: names, context windows, pricing, provider mapping.
Previous was 208 lines.
- `models.ts` ~100 lines

### 2g. Inbox handler (+70)
Watch for externally-queued messages (from `hal send`).
Previous: inbox.ts 33 + inbox-handler.ts 164. Simplify.
- `runtime/inbox.ts` ~70 lines

**Cumulative after Runtime: ~4,435**

---

## 3. Session (+500 lines, cumulative: ~4,935)

### 3a. History write (+200)
Append to history.asonl, blob creation, fork support.
Previous: history.ts 286 (read+write) + blob.ts 69. We already have
read (77 lines in sessions.ts). Add write.
- Expand `server/sessions.ts` from 77 → ~200 lines
- `session/blob.ts` ~50 lines for blob write

### 3b. Replay workers (+120)
Background session replay: rebuild session state from history on startup.
Previous: replay.ts 276 + replay-worker.ts 43. Simplify.
- `session/replay.ts` ~120 lines

### 3c. API messages (+100)
Convert history blocks → provider API message format. Each provider has
different schemas (Anthropic content blocks vs OpenAI messages).
Previous: api-messages.ts 202.
- `session/api-messages.ts` ~100 lines

### 3d. Attachments + pruning (+80)
Image/file attachments in messages. Prune old sessions.
Previous: attachments.ts 76 + history-fork.ts 63.
- `session/attachments.ts` ~50 lines
- Pruning in sessions.ts ~30 lines

**Cumulative after Session: ~4,935**

---

## 4. Providers (+500 lines, cumulative: ~5,435)

### 4a. Shared provider base (+75)
Common interface: stream(), abort(), message format conversion.
Previous: provider.ts 75 + loader.ts 26.
- `providers/provider.ts` ~75 lines

### 4b. Anthropic (+200)
Streaming, tool_use handling, prompt caching. Previous: 243 lines.
- `providers/anthropic.ts` ~200 lines

### 4c. OpenAI + compat (+200)
OpenAI native + compatible endpoints (Groq, Deepseek, local).
Previous: openai.ts 329 + openai-compat.ts 214. Heavy duplication.
Merge into one with a compat flag.
- `providers/openai.ts` ~200 lines

### 4d. Token calibration (+25)
Rough token estimation for context management.
- In `providers/provider.ts` or inline ~25 lines

**Cumulative after Providers: ~5,435**

---

## 5. Tools (+450 lines, cumulative: ~5,885)

### 5a. Tool registry + base (+50)
Tool interface, registration, dispatch.
- `tools/tool.ts` ~50 lines

### 5b. Bash (+100)
Shell execution with timeout, output capture, PTY.
Previous: 115 lines in bash.ts (part of combined).
- `tools/bash.ts` ~100 lines

### 5c. Read/Grep/Glob/Ls (+120)
File reading tools. Previous: read 50 + grep 45 + glob 36 + ls 53 = 184.
Share file-walking logic.
- `tools/read.ts` ~50 lines
- `tools/grep.ts` ~40 lines
- `tools/glob.ts` ~30 lines

### 5d. Write/Edit (+80)
File creation and surgical editing.
Previous: write 43 + file-utils 74.
- `tools/write.ts` ~80 lines

### 5e. Eval (+50)
Runtime JS eval for hot-patching. Previous: 81 lines.
- `tools/eval.ts` ~50 lines

### 5f. Send (+50)
Send message to another Hal session.
- `tools/send.ts` ~50 lines

**Cumulative after Tools: ~5,885**

---

## 6. MCP (+180 lines, cumulative: ~6,065)

MCP client for external tool servers. Previous: client.ts 220 + mock 76.
Skip mock for now.
- `mcp/client.ts` ~180 lines

**Cumulative after MCP: ~6,065**

---

## 7. Remaining utils/perf/polish (+200 lines, cumulative: ~6,265)

### 7a. Perf improvements (+80)
Startup trace, timing waterfall. Previous: startup-trace.ts 181.
Simplify to what we actually use.
- Expand `perf.ts` from 32 → ~80 lines
- Perf event handling ~30 lines

### 7b. Logging (+40)
Structured log to file for debugging. Previous: log.ts 61.
- `utils/log.ts` ~40 lines

### 7c. Misc utils (+50)
is-pid-alive, read-file caching, etc.
- Various small utilities ~50 lines

### 7d. Client state persistence (+30)
Persist active tab, peak, etc. across restarts.
- Already partially in client.ts, expand ~30 lines

**Cumulative after all: ~6,265**

---

## Summary

| Phase | Lines added | Cumulative | % of 10k budget |
|---|---|---|---|
| Current | 2,985 | 2,985 | 30% |
| 1. CLI/UI remaining | +350 | 3,335 | 33% |
| 2. Runtime/Agent | +1,100 | 4,435 | 44% |
| 3. Session | +500 | 4,935 | 49% |
| 4. Providers | +500 | 5,435 | 54% |
| 5. Tools | +450 | 5,885 | 59% |
| 6. MCP | +180 | 6,065 | 61% |
| 7. Utils/perf/polish | +200 | 6,265 | 63% |

**Projected total: ~6,265 lines** — 63% of budget, 3,735 lines of headroom.

Previous codebase was 12,362 lines. This is roughly half, because:
- No tab module (folded into client.ts + render.ts)
- No restart-logic.ts (10 lines in main.ts)
- No diff engine file (merged into render.ts)
- Merged openai + openai-compat
- Merged startup + runtime
- Merged context + system prompt
- Smaller blocks.ts (tool-format.ts merged in)
- Smaller colors.ts (oklch extracted to utility)

## Marching Order

1. **CLI/UI** — finish the visual layer so we can see what we're building
2. **Runtime** — agent loop + commands, the core brain
3. **Session** — write path + replay, so conversations persist
4. **Providers** — Anthropic first (our main), then OpenAI
5. **Tools** — bash first (most used), then read/write, then the rest
6. **MCP** — last, it's a nice-to-have that extends tools
7. **Polish** — perf, logging, edge cases
