# Hot-patchable modules refactor

## Goal

Make every function in the codebase hot-patchable at runtime via the eval tool.
This enables live debugging, monkey-patching, and state inspection without restart.

## Pattern

Every module that exports functions gets a mutable namespace object:

```ts
// Before
export function ensureBus() { ... }
export function getState() { ... }

// After
function ensureBus() { ... }
function getState() { ... }
export const ipc = { ensureBus, getState }
```

Callers change from:
```ts
import { ensureBus, getState } from '../ipc.ts'
ensureBus()
```
To:
```ts
import { ipc } from '../ipc.ts'
ipc.ensureBus()
```

For modules with module-level state, also export it:
```ts
const bus: Bus | null = null
export const state = { bus }
// OR just put state fields in the namespace object
export const ipc = { ensureBus, getState, bus: null as Bus | null }
```

## Rules

1. Functions are defined as normal named functions (not arrow functions in the object) — IDE cmd-click works.
2. The namespace object is `export const` (the binding is const, but the object is mutable — properties can be reassigned).
3. Namespace name = module name (e.g. `ipc.ts` → `export const ipc = { ... }`).
4. Types/interfaces stay as direct named exports — they're compile-time only.
5. Constants (like `STATE_DIR`) stay as direct named exports — no point patching constants.
6. Classes stay as direct named exports — they're already patchable via prototype.
7. Internal calls within the same module use the direct function name (not `ipc.ensureBus()`). Hot-patching targets cross-module boundaries.
8. Re-export files (like `colors.ts`) stay as-is.

## Modules to convert

### `src/ipc.ts` → `export const ipc = { ... }`

Exports to wrap:
- `ensureBus`, `getState`, `updateState`, `claimHost`, `verifyHost`, `releaseHost`, `log`

Keep as direct exports:
- `commands`, `events` (Log instances — could go in namespace too, your call)

Callers:
- `src/main.ts`: `import { ensureBus, claimHost, ... } from './ipc.ts'`
- `src/cli/cli.ts`: `import { events, commands, ... } from './ipc.ts'`
- `src/runtime/startup.ts`: `import { commands, events, getState, updateState, log } from '../ipc.ts'`
- `src/runtime/commands.ts`: `import { log, updateState, getState } from '../ipc.ts'`
- `src/runtime/runtime.ts`: `import { events, updateState, log } from '../ipc.ts'`
- `src/runtime/agent-loop.ts`: `import { log } from '../ipc.ts'`

### `src/config.ts` → `export const config = { getConfig }`

Exports to wrap:
- `getConfig`

Keep as direct exports:
- `Config`, `PermissionLevel` (types)

Callers: many — grep for `import { getConfig`

### `src/models.ts` → `export const models = { ... }`

Exports to wrap:
- `modelCompletions`, `resolveModel`, `displayModel`

Callers:
- `src/cli/cli.ts`
- `src/runtime/commands.ts`
- `src/runtime/runtime.ts`
- `src/session/replay.ts`

### `src/state.ts` — SKIP

All exports are constants (`STATE_DIR`, `HAL_DIR`, etc.) and tiny helper functions (`sessionDir`, `ensureDir`). No point wrapping.

### `src/main.ts` — SKIP

Entry point, not imported by much.

### `src/cli/cli.ts` → `export const cli = { ... }`

Exports to wrap:
- `contentWidth`, `showError`, `doRender`, `quit`, `restart`, `suspend`

Keep as direct exports:
- `client` (instance), `inputCtx` (object)

Callers:
- `src/cli/keybindings.ts`
- `src/cli/prompt.ts`
- `src/cli/tabs.ts`

### `src/cli/blocks.ts` → `export const blocks = { ... }`

Exports to wrap:
- `renderBlocks`, `renderQuestion`

Keep as direct exports:
- `Block` (type)

Callers:
- `src/cli/cli.ts`
- `src/session/replay.ts`

### `src/cli/client-state.ts` → `export const clientState = { ... }`

Exports to wrap:
- `getLastTab`, `saveLastTab`

Callers:
- `src/cli/cli.ts`

### `src/cli/clipboard.ts` → `export const clipboard = { ... }`

Exports to wrap:
- `resetPasteCounter`, `hasPendingPastes`, `pasteFromClipboard`, `saveMultilinePaste`, `cleanPaste`

Callers:
- `src/cli/keybindings.ts`
- `src/cli/prompt.ts`

### `src/cli/colors.ts` — SKIP

Pure constants object, already exported as a namespace.

### `src/cli/completion.ts` → `export const completion = { ... }`

Exports to wrap:
- `completeInput`

Keep as direct exports:
- `CompletionTab`, `CompletionContext`, `CompletionResult` (types)

Callers:
- `src/cli/keybindings.ts`

### `src/cli/cursor.ts` → `export const cursor = { ... }`

Exports to wrap:
- `isVisible`, `start`, `stop`

Callers:
- `src/cli/cli.ts`

### `src/cli/diff-engine.ts` → `export const diffEngine = { ... }`

Exports to wrap:
- `render`

Keep as direct exports:
- `RenderState`, `CursorPos`, `emptyState` (types/constants)

Callers:
- `src/cli/cli.ts`

### `src/cli/heights.ts` → `export const heights = { ... }`

Exports to wrap:
- `maxTabHeight`

Keep as direct exports:
- `HeightTab` (type)

Callers:
- `src/cli/cli.ts`

### `src/cli/input.ts` → `export const input = { ... }`

Exports to wrap:
- `wordWrapLines`, `getWrappedInputLayout`, `cursorToWrappedRowCol`, `wrappedRowColToCursor`, `verticalMove`, `wordBoundaryLeft`, `wordBoundaryRight`

Keep as direct exports:
- `WrappedInputLayout`, `VerticalMoveResult` (types)

Callers:
- `src/cli/prompt.ts`
- `src/cli/keybindings.ts`
- `src/cli/cli.ts`

### `src/cli/keybindings.ts` → `export const keybindings = { ... }`

Exports to wrap:
- `handleInput`

Keep as direct exports:
- `InputContext` (type)

Callers:
- `src/cli/cli.ts`

### `src/cli/keys.ts` → `export const keys = { ... }`

Exports to wrap:
- `parseKey`, `parseKeys`

Keep as direct exports:
- `KeyEvent` (type)

Callers:
- `src/cli/cli.ts`
- `src/cli/test-driver.ts`

### `src/cli/md.ts` → `export const md = { ... }`

Exports to wrap:
- `mdSpans`, `mdInline`, `mdTable`

Keep as direct exports:
- `MdColors`, `MdSpan` (types)
- Re-exports from strings.ts (`charWidth`, `visLen`, `wordWrap`, `clipVisual`) — keep as re-exports

Callers:
- `src/cli/blocks.ts`
- `src/cli/tabline.ts`
- `src/cli/cli.ts`

### `src/cli/prompt.ts` → `export const prompt = { ... }`

Exports to wrap:
- `setQuestion`, `clearQuestion`, `hasQuestion`, `getQuestionLabel`, `frozenText`, `setHistory`, `pushHistory`, `text`, `cursorPos`, `selection`, `setText`, `clear`, `reset`, `setRenderCallback`, `handleKey`, `buildPrompt`, `lineCount`

Callers:
- `src/cli/cli.ts`
- `src/cli/keybindings.ts`

### `src/cli/tabline.ts` → `export const tabline = { ... }`

Exports to wrap:
- `renderTabline`

Keep as direct exports:
- `TablineTab` (type)

Callers:
- `src/cli/cli.ts`

### `src/cli/tabs.ts` → `export const tabs = { ... }`

Exports to wrap:
- `all`, `active`, `activeIndex`, `count`, `create`, `fork`, `closeCurrent`, `next`, `prev`, `switchTo`

Keep as direct exports:
- `Tab` (type)

Callers:
- `src/cli/cli.ts`
- `src/cli/keybindings.ts`

### `src/cli/transport.ts` — SKIP

Class-based (`LocalTransport`), already patchable via prototype.

### `src/providers/loader.ts` → `export const loader = { ... }`

Exports to wrap:
- `loadProvider`

Callers:
- `src/runtime/commands.ts`

### `src/providers/provider.ts` → `export const provider = { ... }`

Exports to wrap:
- `readWithTimeout`

Keep as direct exports:
- `ProviderEvent`, `GenerateParams`, `Provider` (types)

Callers:
- `src/providers/anthropic-provider.ts`
- `src/providers/openai-provider.ts`

### `src/runtime/agent-loop.ts` → `export const agentLoop = { ... }`

Exports to wrap:
- `runAgentLoop`

Keep as direct exports:
- `AgentContext` (type)

Callers:
- `src/runtime/runtime.ts`

### `src/runtime/auth.ts` → `export const auth = { ... }`

Exports to wrap:
- `getAuth`, `refreshAnthropicAuth`, `extractOpenAIAccountId`, `isApiKey`, `openaiUsesCodex`, `refreshOpenAIAuth`

Callers:
- `src/providers/anthropic-provider.ts`
- `src/providers/openai-provider.ts`

### `src/runtime/blink.ts` → `export const blink = { ... }`

Exports to wrap:
- `createBlinkParser`

Keep as direct exports:
- `DEFAULT_BLINK_MS`, `BlinkSegment` (constant/type)

Callers:
- `src/runtime/agent-loop.ts`

### `src/runtime/commands.ts` → `export const commands = { ... }`

**CONFLICT**: `src/ipc.ts` already exports `commands` (the Log instance). This module's namespace should be `commandHandlers` or similar. Or: since ipc.ts's commands becomes `ipc.commands`, this can be `commands`.

Exports to wrap:
- `handleCommand`

Callers:
- `src/runtime/startup.ts`

### `src/runtime/context.ts` → `export const context = { ... }`

Exports to wrap:
- `contextWindowForModel`, `saveCalibration`, `isCalibrated`, `estimateTokens`, `messageBytes`, `estimateContext`

Callers:
- `src/runtime/runtime.ts`
- `src/runtime/agent-loop.ts`
- `src/runtime/commands.ts`

### `src/runtime/eval-tool.ts` → `export const evalTool = { ... }`

Exports to wrap:
- `executeEval`

Keep as direct exports:
- `EvalContext` (type)

Callers:
- `src/runtime/tools.ts`

### `src/runtime/hooks.ts` → `export const hooks = { ... }`

Exports to wrap:
- `runHooks`

Callers:
- `src/runtime/tools.ts`

### `src/runtime/runtime.ts` — SKIP

Already a class (`Runtime`) — patchable via prototype. `getRuntime`/`setRuntime` are the singleton accessors.

### `src/runtime/startup.ts` → `export const startup = { ... }`

Exports to wrap:
- `startRuntime`

Callers:
- `src/main.ts`

### `src/runtime/system-prompt.ts` → `export const systemPrompt = { ... }`

Exports to wrap:
- `loadSystemPrompt`

Keep as direct exports:
- `SystemPromptResult` (type)

Callers:
- `src/runtime/runtime.ts`
- `src/runtime/agent-loop.ts`

### `src/runtime/tools.ts` → `export const tools = { ... }`

Exports to wrap:
- `truncate`, `getTools`, `argsPreview`, `executeTool`

Keep as direct exports:
- `TOOLS` (re-export of BASE_TOOLS), `ToolCall` (type)

Callers:
- `src/runtime/runtime.ts`
- `src/runtime/agent-loop.ts`
- `src/runtime/commands.ts`

### `src/runtime/token-calibration.ts` → `export const tokenCalibration = { ... }`

Exports to wrap:
- `saveTokenCalibration`, `isModelCalibrated`, `estimateTokensSync`

Keep as direct exports:
- `TokenCalibration` (type)

Callers:
- `src/runtime/context.ts`

### `src/session/compact.ts` → `export const compact = { ... }`

Exports to wrap:
- `compactApiMessages`

Keep as direct exports:
- `CompactOpts` (type)

Callers:
- `src/runtime/commands.ts`

### `src/session/history.ts` → `export const messages = { ... }`

Exports to wrap:
- `makeBlobId`, `writeBlob`, `readBlob`, `getLastUsage`, `writeAssistantEntry`, `writeToolResultEntry`, `updateBlobInput`, `parseUserContent`, `appendMessages`, `readMessages`, `loadApiMessages`, `loadAllMessages`, `detectInterruptedTools`, `buildCompactionContext`, `loadInputHistory`, `saveDraft`

Keep as direct exports:
- `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `Message` (types)

Callers: many — `runtime.ts`, `commands.ts`, `agent-loop.ts`, `startup.ts`, `replay.ts`, `cli.ts`

### `src/session/replay.ts` → `export const replay = { ... }`

Exports to wrap:
- `replayToBlocks`

Callers:
- `src/cli/transport.ts`

### `src/session/session.ts` → `export const session = { ... }`

Exports to wrap:
- `makeSessionId`, `loadMeta`, `createSession`, `listSessionIds`, `forkSession`, `currentLog`, `rotateLog`

Keep as direct exports:
- `SessionInfo` (type re-export), `logNameCache` (Map — put in namespace)

Callers: many — `runtime.ts`, `commands.ts`, `startup.ts`, `cli.ts`, `tabs.ts`

### `src/utils/ason.ts` — SKIP

Already has `export default { stringify, parse, parseAll, parseStream, COMMENTS }`.

### `src/utils/is-pid-alive.ts` → `export const pidUtils = { ... }`

Or just leave it — single function, rarely patched.

SKIP — too small.

### `src/utils/live-file.ts` → `export const liveFileUtils = { ... }`

SKIP — single function.

### `src/utils/log.ts` — SKIP

Class-based.

### `src/utils/strings.ts` → `export const strings = { ... }`

Exports to wrap:
- `charWidth`, `visLen`, `wordWrap`, `clipVisual`

Callers:
- `src/cli/md.ts` (re-exports)
- `src/cli/blocks.ts`

### `src/utils/tail-file.ts` — SKIP

Single function.

## Execution order

1. Start with leaf modules (no imports from other converted modules): `strings`, `keys`, `cursor`, `colors`
2. Work inward: `md`, `input`, `clipboard`, `prompt`, `completion`, `keybindings`
3. Core modules: `ipc`, `config`, `models`, `session`, `messages`, `compact`
4. Runtime: `auth`, `blink`, `context`, `tools`, `hooks`, `eval-tool`, `system-prompt`, `agent-loop`, `commands`, `startup`
5. UI: `blocks`, `tabline`, `tabs`, `heights`, `diff-engine`, `client-state`, `cli`

## Testing

After each module conversion, run `./test`. All 351 tests must pass.

## What NOT to change

- Type/interface exports — stay as named exports
- Constants — stay as named exports
- Classes — stay as named exports (patchable via prototype)
- `state.ts` — all constants
- `ason.ts` — already has default namespace export
- Single-function utility files (`is-pid-alive.ts`, `live-file.ts`, `tail-file.ts`)
- Test files
- Provider files (anthropic/openai/mock) — they export `default provider` which is already an object
