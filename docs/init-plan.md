# Startup init plan

## Goal

Make module loading cheap and predictable by banning startup side effects at import time.
Only explicit `init()` calls may do startup work.

## Rule

- Importing a module must be safe and cheap.
- Allowed at import time:
	- type declarations
	- constants
	- pure helper/function definitions
	- namespace object assembly
	- cheap in-memory container creation like `new Map()` when it has no external effects
- Forbidden at import time:
	- file I/O
	- network I/O
	- `fs.watch()` / timers / intervals
	- process signal handlers
	- tool registration
	- config loading / applying
	- IPC lock work
	- starting runtime / CLI / background loops
	- calling another module's `init()`

## Target shape

Each stateful or startup-participating module should look like:

```ts
const state = {
	initialized: false,
	// other state
}

function init(): void {
	if (state.initialized) return
	state.initialized = true
	// startup work here
}

export const moduleName = { state, init, ... }
```

Notes:
- `init()` must be idempotent.
- Cross-module startup order must live in one place only.
- Startup should be split by concern if needed: `initConfig()`, `initRuntime()`, etc. But the order still belongs to one bootstrap path.

## Recommended phases

1. **Define the contract**
	- Add the import-time purity rule to `AGENTS.md`
	- Decide whether tool registration also moves behind explicit init (recommended: yes)

2. **Inventory current import side effects**
	- List every module that currently does work at import time
	- Group them into:
		- file/config loading
		- watchers
		- tool registration
		- runtime/process startup
		- caches/live state initialization

3. **Create explicit bootstrap**
	- Add a startup coordinator module, e.g. `src/bootstrap.ts`
	- Move all startup ordering there
	- `main.ts` should mostly become:
		- mark perf start
		- call bootstrap init phases in order
		- start host/client flow

4. **Move low-risk modules first**
	- Tool modules: replace self-registration on import with `init()` registration
	- Pure config/watch modules: move file loading and watcher setup into `init()`
	- Color/config/live file loaders are good early targets

5. **Move runtime modules next**
	- Anything that installs timers, signal handlers, or IPC watchers moves behind explicit init
	- Keep module exports mutable and eval-patchable

6. **Add guardrails**
	- Add a test that imports all non-test modules except `main.ts` and asserts no banned external effects happen during import
	- Add a lint-like script or test for obvious top-level calls in `src/`
	- Benchmark import-only startup before/after

7. **Trim after migration**
	- Once init order is explicit, measure each phase
	- Then decide what can be lazy-loaded, deferred, or deleted

## Suggested migration order

1. tool registration modules
2. `config.ts`
3. `cli/colors.ts`
4. `openai-usage.ts`
5. other live-file/watcher modules
6. `main.ts` bootstrap split
7. import-side-effect regression tests

## Definition of done

- Importing any non-entry module performs no file I/O, watcher setup, registration, timers, or process wiring
- Startup order is explicit and centralized
- Each startup module has idempotent `init()`
- Import-only benchmark is stable and easy to run
- Future contributors are blocked by docs/tests from reintroducing import-time side effects
