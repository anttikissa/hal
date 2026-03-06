# IPC/Runtime Questions

Questions that came up while building. None are blockers — everything works end-to-end.

## Architecture

1. **Session registry**: The old code has `index.ason` listing all sessions. The new code
   derives the session list from `state.ason` (host-written) + individual `meta.ason` files.
   This avoids the dual-source-of-truth bug. But it means the host must persist session order
   to `state.ason` — is that OK, or do you want a separate `index.ason`?

2. **Tab state ownership**: Currently the Client creates tabs from sessions events. Tab
   ordering/switching is purely local (client-side). The host only knows about sessions and
   `activeSessionId`. This means two clients can have different tab orders. Is that intentional?

3. **Pause/resume**: Not yet implemented. The old code had `pausedSessionIds`. Do you want
   pause to cancel the running generation, or just suppress output until resume?

4. **Fork**: Not yet implemented. The old session fork (forked_from in messages.asonl) is
   supported in message loading, but there's no `fork` command handler yet. Should fork
   create a new session + copy blocks, or use the reference-based approach from old code?

5. **Steer/drop/queue**: Not implemented. These seem like they need the generation to be
   cancellable (AbortController). How important are these for the initial version?

## Transport

6. **Remote transport**: The Transport interface is ready for HTTP/SSE. The plan mentions
   `POST /command, GET /events (SSE), GET /state, GET /sessions/:id/messages`. Should
   the web server live in the host process (like old `src/web.ts`), or separate?

7. **Event offset for remote clients**: Remote clients can't use byte offsets into the events
   file. Should the HTTP transport use sequence numbers instead? Or just SSE with last-event-id?

## Tooling

8. **Tool execution**: The agent-loop has a TODO for tool calls. The mock provider doesn't
   emit tool_call events. When you're ready to add real providers, I'll add tool execution —
   but do you want tool code in the new/ tree or should it use the old tool implementations?

## Testing

9. **Runtime tests use `NEW_STATE_DIR` env var**: Tests need to be run with
   `NEW_STATE_DIR=/tmp/... bun test` to isolate from real state. This works but is a bit
   clunky. Alternative: make state paths configurable at init time instead of module-level
   constants. Worth refactoring?
