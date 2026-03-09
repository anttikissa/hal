# Context estimation plan

## Current state

What works:
- `context.ts`: calibration (bytes/token ratio) persisted per model in `state/calibration.ason`
- Agent loop: estimates context before first API call, calibrates on first response, sends real usage after
- Runtime: stores context per session in `sessionContext` map, publishes via IPC `status` event
- Runtime: saves non-estimated context to `SessionInfo.context`, restores it on restart (line 62)
- Client: stores `context` per tab, displays in separator as `~52.5%/200k` (estimated) or `52.5%/200k` (real)

What's missing:
- Sessions restored from disk that have no saved `info.context` (never got a real API response) show nothing
- System prompt bytes are not included in the estimate at restore time (only during `runAgentLoop`)

## Plan

### 1. Estimate on session restore (runtime.ts)

When restoring sessions, if `meta.context` is missing, compute an estimate:
- Load API messages for the session
- Sum `messageBytes()` across all messages
- Use `estimateTokens(bytes, modelId)` with calibrated ratio
- Set in `sessionContext` with `estimated: true`

This covers the "restarted but never got real usage" case.

Note: the system prompt is NOT included in the restore estimate (we don't know which model was used 
or what the prompt was at that time). This is fine — the estimate is approximate anyway, and 
once a generation starts, the agent loop computes a proper estimate including the system prompt.

### 2. Files to change

- `src/runtime/runtime.ts` — add estimate in session restore loop (import `contextWindowForModel`, `estimateTokens`, `messageBytes`)

That's it. One file, ~8 lines.
