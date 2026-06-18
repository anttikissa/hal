# Session files

Hal keeps restart-surviving conversation state under `state/sessions/<id>/`.
Provider context is rebuilt from durable history, not from live UI snapshots or IPC state.

## `session.ason`

Durable session metadata:

- `id`, creation time, optional name/tab close state.
- `workingDir` and `model` used for the next turn.
- `currentLog`, the active history log file.
- fork/spawn metadata.
- last known context estimate (`context.used` / `context.max`).

## `history*.asonl`

Append-oriented logical conversation history. Each line is one short ASON record.
The flat, UI-friendly entries are replayed into provider messages by
`src/session/api-messages.ts`.

Forks can inherit parent history; blob ownership follows the history origin when
rendering inherited entries.

Restart-surviving semantic state must be represented here. In particular,
`pending_tools` is an explicit marker that a full local tool-call batch has been
persisted but intentionally not executed yet:

```ts
{ type: 'pending_tools', toolIds: string[], cwd: string, model?: string, usage?: PartialTokenUsage, reason?: 'soft-pause', ts?: string }
```

The marker appears immediately after the assistant/tool-call batch it protects.
While unresolved, provider-message rebuild must not proceed because normal repair
would treat the missing tool results as an interruption. Continuing executes the
listed local tools using the persisted cwd, appends `tool_result` entries, then
marks the marker `canceled: true` through the current history rewrite helper.

## `live.ason`

Restart-tolerant UI snapshot for uncommitted streaming blocks. It keeps the
terminal display useful across client/runtime restarts, but it is not the
authoritative provider context and is cleared when streamed content is committed
to history.

## `blobs/*.ason`

Large thinking, tool-call, tool-result, and error payloads referenced from
history/live entries.

## `state/ipc/*.ason*`

Commands, events, shared tab/process state, and other file-based IPC. This is
coordination state, not conversation truth.

## Restart invariant

Provider context is rebuilt from `history*.asonl`. Anything that must survive a
runtime/client restart must be represented in history or session metadata, not
only in memory, live UI state, or IPC events.
