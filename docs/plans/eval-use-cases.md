# Eval tool: 5 use cases only possible with in-process access

## 1. Live restart

**Problem:** No restart tool exists. `bash` can't call `process.exit(100)` in the Hal process — it spawns a subprocess. Ctrl-R works but requires user action.

**With eval:**
```ts
process.exit(100)
```

One line. The `run` script sees exit code 100 and restarts. No other tool can do this because `process` refers to the *Hal* process, not a child shell.

---

## 2. Inspect live session state

**Problem:** Session data on disk (messages.asonl) is the persisted view. But the runtime holds ephemeral state that never hits disk: which sessions are busy, abort controllers, pending questions, context window estimates, in-flight tool calls.

**With eval:**
```ts
import { getState } from '~src/ipc.ts'
const state = getState()
return state
```

Or directly from runtime (once ctx.runtime is threaded):
```ts
return {
  sessions: [...ctx.runtime.sessions.entries()].map(([id, s]) => ({
    id, model: s.model, busy: ctx.runtime.busySessionIds.has(id)
  })),
  active: ctx.runtime.activeSessionId,
}
```

`bash` can read IPC files, but can't see the in-memory Maps, Sets, or AbortControllers.

---

## 3. Hot-patch a module at runtime

**Problem:** Found a bug mid-conversation. Currently: edit file, ask user to Ctrl-R, lose streaming state. With eval, some fixes can be applied live.

**With eval:**
```ts
// Monkey-patch a function in a loaded module
import * as tools from '~src/runtime/tools.ts'
const original = tools.executeTool
tools.executeTool = async (...args) => {
  console.log('[patch] tool call:', args[0])
  return original(...args)
}
return 'patched'
```

This is dangerous and temporary (cleared on restart) — but for debugging it's invaluable. No other tool can modify the running process's module exports.

---

## 4. Emit IPC events directly

**Problem:** The CLI and runtime communicate via an IPC bus (file-backed append logs). `bash` can append raw lines to IPC files, but the format is ASON with specific event types, IDs, and timestamps — easy to get wrong. More importantly, the runtime's in-memory offset tracking would get confused.

**With eval:**
```ts
import { events } from '~src/ipc.ts'
await events.append({
  id: crypto.randomUUID(),
  createdAt: new Date().toISOString(),
  type: 'line',
  sessionId: ctx.sessionId,
  text: 'Hello from eval!',
  level: 'info',
})
return 'event emitted'
```

This goes through the proper append path, updating offsets and triggering any watchers. `bash` can't do this correctly because it doesn't have the in-memory log instance.

---

## 5. Query Bun internals and process diagnostics

**Problem:** Debugging memory leaks, file descriptor exhaustion, event loop stalls. `bash` can see the process from the outside (`lsof`, `ps`), but can't inspect Bun's internal heap, import cache, or open handles.

**With eval:**
```ts
return {
  memory: process.memoryUsage(),
  uptime: process.uptime(),
  pid: process.pid,
  versions: process.versions,
  importMeta: import.meta.dir,
  env: { HAL_DIR: process.env.HAL_DIR, HAL_STATE_DIR: process.env.HAL_STATE_DIR },
}
```

Or for deeper inspection:
```ts
// Force garbage collection (if --expose-gc is set)
if (globalThis.gc) globalThis.gc()
return process.memoryUsage()
```

`bash` can run `ps aux | grep hal` but can't call `process.memoryUsage()` on the *right* process. The eval tool is the process.
