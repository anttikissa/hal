# New HAL — Build Plan

## Goal

Standalone HAL runtime + TUI client in `new/`. Reuses the IPC protocol
design but runs independently from the old HAL (separate state dir:
`new-state/`). No real providers yet — mock provider for development.
Max 500 LOC per file.

## Terminology

- **Host** — the elected process that runs the runtime (provider calls,
  command dispatch, session management, HTTP server). One at a time.
- **Client** — any process consuming events and sending commands. Local
  clients use file-backed IPC. Remote clients use HTTP/SSE. Local clients
  can be promoted to host if the current host dies.

## File layout

```
new/
  main.ts                — host election → start runtime + CLI
  run                    — bash entry (restart loop, env vars)
  protocol.ts            — command/event/state types, makeCommand()
  config.ts              — liveFile-backed config.ason
  ipc.ts                 — file-backed IPC bus (local transport)
  state.ts               — resolved paths (STATE_DIR, IPC_DIR, etc.)
  live-file.ts           — proxy-backed auto-persist + fs.watch

  utils/
    ason.ts              — ASON parser/serializer (copy from src/)
    tail-file.ts         — tail -f byte stream (copy from src/)

  runtime/
    runtime.ts           — host loop: tail commands, dispatch, manage sessions
    agent-loop.ts        — per-session: build messages, call provider, emit events
    provider.ts          — Provider interface + dynamic loader
    mock-provider.ts     — current simulator reshaped as a provider

  session/
    session.ts           — create/load/list sessions, SessionInfo type
    messages.ts          — append/read conversation messages (per-session)
    replay.ts            — messages → Block[] for history display

  cli/
    tui.ts               — terminal setup, input loop, buildLines(), doRender()
    client.ts            — transport-agnostic: bootstrap, event→block, tab sync
    transport.ts         — Transport interface + local file-backed implementation
    blocks.ts            — Block types + ANSI block renderer
    prompt.ts            — prompt line editing
    input.ts             — low-level input buffer
    keys.ts              — key parser
    diff-engine.ts       — line-level diff renderer
    tabs.ts              — tab state (id, blocks, prompt draft)
    cursor.ts            — hal cursor blink timer
```

## Transport interface

```ts
interface Transport {
  sendCommand(cmd: RuntimeCommand): Promise<void>
  events(fromOffset?: number): AsyncGenerator<RuntimeEvent>
  bootstrap(): Promise<BootstrapState>
  replaySession(id: string): Promise<Message[]>
}
```

Local (file-backed): reads state.ason, tails events.asonl, appends to
commands.asonl, reads session messages.asonl.

Remote (HTTP, future): POST /command, GET /events (SSE), GET /state,
GET /sessions/:id/messages.

Client code uses Transport — doesn't know or care which.

## Data flow

### Live streaming
```
user types → tui.ts → client.ts → transport.sendCommand('prompt')
  → commands.asonl → runtime.ts dispatches → agent-loop.ts calls provider
  → provider yields ProviderEvents
  → agent-loop emits RuntimeEvents to events.asonl + writes messages.asonl
  → transport.events() → client.ts translates to Block mutations
  → tui.ts re-renders via diff engine
```

### History replay (on startup / tab restore)
```
transport.replaySession(id) → reads messages.asonl
  → replay.ts converts to Block[] → client.ts sets tab.blocks
  → tui.ts renders
```

### Bootstrap (fast, <50ms)
```
transport.bootstrap() → reads state.ason (session IDs + active)
  → for each open session: read meta.ason (liveFile, cached)
  → client.ts creates tabs with session info
  → tail events from known offset (no gap)
  → replay history in background (async)
```

## Storage

### IPC (host-managed, transient)
```
new-state/ipc/
  host.lock            — { hostId, pid }
  commands.asonl       — clients append
  events.asonl         — host appends (trimmed on restart)
  state.ason           — host-only: { sessions: string[], ... }
```

### Sessions (persistent)
```
new-state/sessions/
  <id>/
    messages.asonl     — conversation: user, assistant, thinking, tool calls
    meta.ason          — { id, name, workingDir, model, createdAt }
```

### Config (user-editable, watched)
```
new-state/config.ason  — { defaultModel, activeSessionId, ... }
```

## liveFile utility

Proxy-backed object with auto-persist and optional fs.watch:
- Shallow property assignment → marks dirty → flushes on next microtask
- Atomic writes (tmp + rename) to prevent corrupt reads
- `save()` for synchronous persist (exit paths)
- fs.watch with debounce for external edits
- ~40 LOC

Used for: config.ason, session meta.ason.
Not used for: .asonl files (append-only), state.ason (host-only, explicit writes).

## Provider interface

```ts
interface Provider {
  name: string
  generate(params: GenerateParams): AsyncGenerator<ProviderEvent>
}

type ProviderEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'done'; usage?: { input: number; output: number } }
  | { type: 'error'; message: string }

interface GenerateParams {
  messages: Message[]
  model: string
  systemPrompt: string
  tools?: ToolDefinition[]
}
```

`loadProvider(name)` → dynamic `import(`./${name}-provider.ts`)`.
Only loads the requested provider's code.

## state.ason (host-only)

Minimal — just enough for fast client bootstrap:
```
{
  sessions: ['s-abc', 's-def'],    // open session IDs, tab order
  busySessionIds: ['s-abc'],       // which are currently running
}
```

activeSessionId lives in config.ason (user preference).
Activity text, context %, model — all in meta.ason or events.
Host is the sole writer. Clients read once + tail events.

## Build sequence

### Phase 1: Foundation
1. `state.ts` — path constants
2. Copy `utils/ason.ts` + `utils/tail-file.ts`
3. `live-file.ts` — proxy utility
4. `config.ts` — config loader
5. `protocol.ts` — types
6. `ipc.ts` — bus operations

### Phase 2: Runtime
7. `session/session.ts` — CRUD
8. `session/messages.ts` — append/read
9. `runtime/provider.ts` — interface + loader
10. `runtime/mock-provider.ts` — simulator as provider
11. `runtime/agent-loop.ts` — drive provider, emit events, persist
12. `runtime/runtime.ts` — command dispatch, session management

### Phase 3: Client + TUI
13. `cli/transport.ts` — Transport interface + local implementation
14. `session/replay.ts` — messages → blocks
15. `cli/client.ts` — bootstrap, event tailing, block translation
16. Refactor `cli/tui.ts` — strip simulator, wire to client
17. Expand `cli/tabs.ts` — add blocks + session fields

### Phase 4: Wire up
18. `main.ts` — host election, start both
19. `run` — bash entry point
20. End-to-end test

## LOC budget

| File | Est |
|---|---|
| main.ts | ~60 |
| state.ts | ~15 |
| config.ts | ~30 |
| live-file.ts | ~40 |
| protocol.ts | ~80 |
| ipc.ts | ~100 |
| utils/ason.ts | 361 (copy) |
| utils/tail-file.ts | 24 (copy) |
| runtime/runtime.ts | ~120 |
| runtime/agent-loop.ts | ~100 |
| runtime/provider.ts | ~30 |
| runtime/mock-provider.ts | ~60 |
| session/session.ts | ~50 |
| session/messages.ts | ~40 |
| session/replay.ts | ~60 |
| cli/transport.ts | ~80 |
| cli/client.ts | ~180 |
| cli/tui.ts | ~180 |
| cli/blocks.ts | 169 (existing) |
| cli/prompt.ts | 183 (existing) |
| cli/diff-engine.ts | 120 (existing) |
| cli/keys.ts | 123 (existing) |
| cli/input.ts | 94 (existing) |
| cli/tabs.ts | ~50 (expanded) |
| cli/cursor.ts | 31 (existing) |
| **Total** | **~2200** |
