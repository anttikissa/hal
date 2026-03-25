# Plan 2/7: Runtime/Agent

## Overview
The core brain: agent loop, slash commands, context building, startup glue, protocol, models, inbox.
Budget: ~1,100 lines added. Target after: ~4,435.

## Subplans

### 2a. Protocol types (~80 lines)

**File:** `src/protocol.ts`

Shared types for IPC events and commands. Define them FIRST so other modules can import.

Port from `prev/src/protocol.ts` (166 lines), trim to what we actually need:
- IPC event types: runtime-start, host-released, sessions, prompt, response, info,
  tool-call, tool-result, stream-start, stream-delta, stream-end, error
- IPC command types: prompt, open, close, abort, compact
- Tool call types: bash, read, write, edit, glob, grep, eval, send
- Message role types: user, assistant, tool_use, tool_result

Convention: export as `export const protocol = { ... }` with type exports alongside.

### 2b. Models registry (~100 lines)

**File:** `src/models.ts`

Port from `prev/src/models.ts` (208 lines), simplify.

- Model interface: { id, name, provider, contextWindow, inputPrice, outputPrice, supportsImages, supportsCaching }
- Registry of known models: Claude (sonnet, opus, haiku), GPT-4o, GPT-4-turbo, o1, o3, Deepseek, Groq/Llama
- `findModel(query: string): Model | null` — fuzzy match by name/id
- `defaultModel(): Model`
- `formatCost(inputTokens: number, outputTokens: number, model: Model): string`

### 2c. Context builder (~150 lines)

**File:** `src/runtime/context.ts`

Merge `prev/src/runtime/context.ts` (180 lines) + `prev/src/runtime/system-prompt.ts` (126→402 lines).

Responsibilities:
- Build system prompt: load AGENTS.md (from cwd and parent dirs), append tool descriptions,
  add date/cwd/session info
- Build conversation messages from history blocks
- Token counting: rough estimation for context window management
- Context window pruning: when approaching limit, summarize or drop old messages

Key functions:
- `buildSystemPrompt(session, cwd: string): string`
- `buildMessages(history: HistoryEntry[], model: Model): Message[]`
- `estimateTokens(messages: Message[]): number`
- `pruneToFit(messages: Message[], maxTokens: number): Message[]`

Must handle AGENTS.md loading: walk up from cwd, collect all AGENTS.md files,
concatenate with directory context headers.

### 2d. Agent loop (~350 lines)

**File:** `src/runtime/agent-loop.ts`

THE CORE. Port from `prev/src/runtime/agent-loop.ts` (403 lines).

The loop:
1. Receive prompt (text + optional attachments)
2. Build messages via context.ts
3. Call provider.stream() with messages
4. Stream response tokens → emit stream-delta events via IPC
5. If response contains tool_use blocks:
   a. Execute each tool call
   b. Append tool_result to messages
   c. GOTO 3 (loop until no more tool calls)
6. Emit stream-end event

Key concerns:
- Abort handling: user can ctrl-c to abort mid-stream
- Error recovery: provider errors should be surfaced as error events, not crash
- Tool call parallelism: independent tool calls can run concurrently
- Max iterations: cap at configurable limit (default 50) to prevent infinite loops
- Streaming: emit deltas as they arrive for real-time display

State:
- `state.activeRequests: Map<sessionId, AbortController>`
- `config.maxIterations: 50`
- `config.maxToolConcurrency: 5`

### 2e. Commands (~250 lines)

**File:** `src/runtime/commands.ts`

Port from `prev/src/runtime/commands.ts` (301 lines).

Slash commands parsed from user prompt text starting with `/`:
- `/model [name]` — switch model, show current if no arg
- `/clear` — clear session history
- `/fork` — fork current session to new tab
- `/compact` — summarize conversation to reduce context
- `/cd [path]` — change working directory
- `/show [what]` — show system prompt, context, etc.
- `/help` — list available commands
- `/exit` — quit
- `/eval [code]` — run JS in runtime (for debugging)

Architecture:
- `parseCommand(text: string): { name: string, args: string } | null`
- `executeCommand(name: string, args: string, session): CommandResult`
- `CommandResult = { output?: string, error?: string, handled: boolean }`

### 2f. Startup + runtime glue (~100 lines)

**Expand:** `src/server/runtime.ts` from 79 → ~180 lines

Replace the echo stub with real agent loop integration:
- On prompt command: feed to agent loop instead of echoing
- On abort command: abort active request
- On compact command: trigger context compaction
- Wire up session history writing (plan 3)
- Handle provider errors gracefully

### 2g. Inbox handler (~70 lines)

**File:** `src/runtime/inbox.ts`

Port from `prev/src/session/inbox.ts` (33 lines) + `prev/src/runtime/inbox-handler.ts` (164 lines).

Watch for externally-queued messages from `hal send`:
- Watch `state/inbox/` directory for new .ason files
- Parse incoming message, route to correct session
- Feed into agent loop as if user typed it
- Delete file after processing

## Dependencies
- 2a (protocol) should be done first — other modules import these types
- 2b (models) needed by 2d (agent loop) for context window limits
- 2c (context) needed by 2d (agent loop)
- 2e (commands) wired into 2f (runtime glue)
- 2d (agent loop) wired into 2f (runtime glue)
- 2g (inbox) depends on 2d

Suggested order: 2a → 2b → 2c → 2d → 2e → 2f → 2g

## Testing
- `bun test` after each subplan
- `bun cloc` to verify budget
