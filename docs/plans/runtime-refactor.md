# Runtime refactor: extract class Runtime + commands

## Goal

Split `runtime.ts` (529 LOC) into:
1. **`runtime.ts`** — `class Runtime` with state + API methods (~200 LOC)
2. **`commands.ts`** — command handlers, each receives `rt: Runtime` (~250 LOC)
3. **`startup.ts`** — `startRuntime()` orchestration (~80 LOC)

## Why

- `runtime.ts` is a single 529-line closure — nothing is importable from outside
- Commands are a 250-line switch statement embedded in the closure
- The eval tool needs access to live runtime state but can't reach it
- Extracting commands makes them testable in isolation

## class Runtime

All closure state moves to class fields. All helper functions become methods.

```ts
export class Runtime {
	// State
	sessions = new Map<string, SessionInfo>()
	activeSessionId: string | null = null
	busySessionIds = new Set<string>()
	abortControllers = new Map<string, AbortController>()
	pendingQuestions = new Map<string, { resolve: (answer: string) => void; question: string }>()
	sessionContext = new Map<string, { used: number; max: number; estimated?: boolean }>()
	pendingInterruptedTools = new Map<string, { name: string; id: string; ref: string }[]>()

	// Methods (current closure functions)
	async emit(fields: Omit<RuntimeEvent, 'id' | 'createdAt'>): Promise<void>
	async emitInfo(sessionId: string, text: string, level: string): Promise<void>
	async publish(activity?: string): Promise<void>
	async startGeneration(sid: string, info: SessionInfo, apiMessages: any[], activity?: string): Promise<void>
	async askUser(sessionId: string, question: string): Promise<string>
	estimateSessionContext(info: SessionInfo, apiMessages: any[]): { used: number; max: number; estimated: true }
	setFreshContext(info: SessionInfo): void
	async greetSession(sessionId: string): Promise<void>
	async resumeInterruptedSession(sessionId: string): Promise<void>
	stop(): void
}
```

## commands.ts

One exported function per command (or one `handleCommand` that dispatches):

```ts
export async function handleCommand(rt: Runtime, cmd: RuntimeCommand): Promise<void> {
	switch (cmd.type) {
		case 'prompt': return handlePrompt(rt, cmd)
		case 'open': return handleOpen(rt, cmd)
		// ... etc
	}
}

async function handlePrompt(rt: Runtime, cmd: RuntimeCommand): Promise<void> { ... }
async function handleOpen(rt: Runtime, cmd: RuntimeCommand): Promise<void> { ... }
```

Each handler uses `rt.emit()`, `rt.publish()`, `rt.sessions`, etc.

## startup.ts

```ts
export async function startRuntime(): Promise<Runtime> {
	await ensureBus()
	const rt = new Runtime()
	// restore sessions, set up watchers, tail commands
	// ...
	for await (const cmd of cmdTail.items) {
		await handleCommand(rt, cmd)
	}
	return rt
}
```

## Eval integration

Once Runtime is a class, the eval tool context gets the live instance:

```ts
// in agent-loop.ts or eval-tool.ts
const ctx = { sessionId, halDir, stateDir, cwd, runtime: rt }
```

Then eval code can do:
```ts
return [...ctx.runtime.busySessionIds]
```

## Module-level singleton for imports

For eval scripts to import runtime state without receiving it as a parameter,
export a getter:

```ts
// runtime.ts
let _instance: Runtime | null = null
export function getRuntime(): Runtime { return _instance! }
// set in startup.ts after construction
```

## Steps

1. Create `src/runtime/commands.ts` — move `handleCommand` switch + all case bodies
2. Convert closure state → `class Runtime` fields + methods in `runtime.ts`
3. Create `src/runtime/startup.ts` — move `startRuntime()` orchestration (restore, watchers, tail loop)
4. Wire `handleCommand(rt, cmd)` in the tail loop
5. Export `getRuntime()` singleton for eval
6. Update `agent-loop.ts` to pass `runtime` in eval context
7. Run tests, fix breakage
8. Run cloc, commit

## Risk

Big refactor — touches the core of the system. All command behavior must be preserved exactly.
The existing test suite will catch regressions. Do it in one pass, don't half-split.
