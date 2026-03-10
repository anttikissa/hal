# In-process eval tool

## Goal

Give the model a tool that executes TypeScript **inside the Hal process**, with full access to runtime state, imports, and internals.

## Key insight: no cache busting

If we add a **single always-present tool** (like `bash` or `read`), the tool list never changes, so prompt cache stays intact. The model writes code as the tool's `code` parameter — no dynamic tool registration needed.

## Design

### Tool definition

```typescript
{ name: 'eval',
  description: 'Execute TypeScript in the Hal process. Full access to runtime internals via ctx.',
  input_schema: { type: 'object', properties: {
    code: { type: 'string', description: 'TypeScript code. Last expression is the return value. ctx has: runtime, sessions, config, ipc, env.' }
  }, required: ['code'] } }
```

### Execution

1. Write code to `state/eval/<id>.ts` (persisted indefinitely for audit trail)
2. Wrap it: export a default async function receiving `ctx`
3. `await import(tempFile)` → call the default export
4. Return the result (JSON.stringify or toString)

```typescript
// Wrapper template:
import type { EvalContext } from '../../src/runtime/eval-context.ts'
export default async (ctx: EvalContext) => {
  <user code>
}
```

### Context object (`EvalContext`)

Minimal — just the stuff that's hard to import:

```typescript
interface EvalContext {
  runtime: Runtime       // the live runtime instance
  sessionId: string      // current session
  halDir: string         // HAL_DIR path
  stateDir: string       // STATE_DIR path
  cwd: string            // LAUNCH_CWD
}
```

The code can `import` anything from `src/` using relative paths from the temp file location. Context is for live singleton instances that can't be imported.

### Example usage

```typescript
// Restart
const { restart } = await import('../../src/cli.ts')
restart()
```

```typescript
// Inspect session state
const sessions = ctx.runtime.sessions
return sessions.map(s => ({ id: s.id, model: s.model }))
```

```typescript
// Read live config
const { getConfig } = await import('../../src/config.ts')
return getConfig()
```

### Error handling

- Wrap execution in try/catch
- Return error message + stack as tool result
- Timeout: kill after 30s (configurable)

### Gating

Disabled by default. Enabled via `config.ason`:

```ason
{ eval: true }
```

When disabled, the tool is simply not included in the tools list — invisible to the model. When enabled, it appears alongside `bash`, `read`, etc.

### Security

Audit only — all executed code persists in `state/eval/`. This is a power-user tool for Hal development.

## Implementation steps

1. Create `src/runtime/eval-tool.ts` — execution logic + context type
2. Add `eval` to TOOLS array in `tools.ts`
3. Add `eval` case to `executeTool` in `tools.ts`
4. Pass runtime instance through to tool execution (need to thread it through)
5. Add to SYSTEM.md description
6. Tests

## Open questions

- **Name**: `eval`, `run`, `hal`, `introspect`? → `eval` is clear
- **Threading runtime**: `executeTool` doesn't currently receive runtime context. Need to add it as a parameter or use a global. A lazy global (set at startup) is simplest.
- **Import paths**: temp file is in `state/eval/`, so relative imports to `src/` need `../../src/`. Alternative: use `HAL_DIR` env var + absolute imports.
