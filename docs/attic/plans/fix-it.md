# Fix plan: new/ IPC, promotion, and restart tab-loss bugs

Date: 2026-03-07

## Goal

Stabilize `new/` so it preserves tabs/sessions across restart, avoids IPC state races, and has reliable promotion behavior when owner changes.

## What old `src/` did better

1. It treated runtime state as owner-written state and did not let random clients overwrite it on local restart paths.
2. It had stronger persistence discipline around session metadata/registry on lifecycle transitions.
3. It avoided some startup races by structuring tails/initialization carefully in runtime startup paths.

## Bugs found in `new/`

### 1) Restart can clobber global state from non-host clients

- `new/cli.ts` `restart()` calls `getState().save()` unconditionally.
- In a non-host process, that writes client-local in-memory state back to shared `ipc/state.ason`.
- If that client is stale, it can overwrite host-owned session list and effectively “lose tabs”.

### 2) State writes are async-microtask and can be stale at critical moments

- `new/ipc.ts` `updateState()` mutates a `liveFile` object but does not force synchronous flush.
- On restart/crash windows, disk state may lag behind emitted events.

### 3) Session meta persistence is not forced before publish/state snapshot

- `createSession()` relies on microtask auto-save; no explicit sync flush.
- Runtime restoration is state-id driven + `loadMeta(id)`; missing/late meta can drop restored tabs.

### 4) Client startup has an event-tail race during replay hydration

- `new/cli/client.ts` currently captures event offset **after** replaying all tabs.
- Events produced during replay are missed forever.
- This can hide session list updates and contribute to apparent tab loss.

### 5) Promotion fallback loop can spin too aggressively

- In `new/main.ts`, failed `tryPromote()` does not adopt returned current owner PID.
- Client can keep attempting lock-claims every 100ms even when another owner is alive.

## Implementation plan

1. **Make owner state updates durable immediately**
   - In `new/ipc.ts:updateState()`, call `save()` after mutation.

2. **Stop non-host restart from writing shared state**
   - In `new/cli.ts:restart()`, remove unconditional `getState().save()`.
   - Keep restart behavior (exit 100, lock not explicitly released).

3. **Force session meta durability for created/opened tabs**
   - In `new/session/session.ts:createSession()`, force an immediate `save()`.
   - In runtime publish path, flush known session meta proxies before updating state snapshot.

4. **Fix client startup event race**
   - In `new/cli/client.ts:start()`, capture `eventsOffset` before hydration replay.
   - Tail from that saved offset after replay.

5. **Reduce promotion spin / stale-watch PID behavior**
   - In `new/main.ts`, when promotion claim fails, update watched PID from claim result.

## Test plan (comprehensive)

### Unit/integration additions

1. `new/ipc.test.ts`
   - Regression: `updateState()` persists to disk immediately.

2. `new/cli/client.startup-race.test.ts` (new)
   - Deterministic transport-based test proving events occurring during replay are not missed.

3. `new/runtime/runtime.test.ts`
   - Restart restoration with multiple sessions (open several tabs, restart runtime, verify full set restored).

### Process/e2e behavior

4. `new/ipc.test.ts` promotion scenario
   - Multi-process host death -> client promotion path still succeeds.
   - Verify no stuck ownership after host termination.

## Validation commands

- `bun test new/ipc.test.ts new/runtime/runtime.test.ts new/cli/client.startup-race.test.ts`
- `bunx tsgo --noEmit`
- `bun scripts/cloc.ts`

Then full suite (recommended before merge):
- `./test`

## Risk notes

- Forcing sync `save()` on state/meta writes increases write frequency, but data sizes are tiny and correctness is preferred.
- Client startup offset change can increase duplicate render risk in edge overlap windows, but it is better than missing events/tabs. We’ll keep replay deterministic and validate with tests.
