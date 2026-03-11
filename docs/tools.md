# Tools

This doc explains where tool code lives, how tool streaming works, and how to keep formatting identical across CLI and web.

## Current split

- `src/runtime/tools.ts`
	- Tool registry exposed to providers (`getTools`)
	- Generic execution entrypoint (`executeTool`)
	- Remaining built-in implementations (`grep`, `glob`, `ls`, `read_blob`, `ask`, `eval`)
- `src/tools/*`
	- Per-tool modules shared across frontends/runtime
	- Migrated tools: `bash`, `read`, `write`, `edit`
	- Shared file helpers: `src/tools/file-utils.ts`

Goal: keep moving tool-specific behavior into `src/tools/*` one tool at a time.

## Bash module (`src/tools/bash.ts`)

`bash.ts` owns bash-specific behavior:

- `bash.definition`
	- Tool schema (name, description, input schema)
- `bash.argsPreview(input)`
	- Short preview string used in tool headers
- `bash.execute(input, ctx, onChunk?)`
	- Runs `bash -lc <command>`
	- Streams stdout via `onChunk`
	- Appends stderr and non-zero exit marker at completion
	- Handles abort by killing full process tree (`SIGTERM` then `SIGKILL`)
- `bash.formatBlock(input)`
	- Shared semantic formatter for tool block content
	- Returns label, optional wrapped command lines, output tail lines, and hidden-line count

### Formatting contract

`bash.formatBlock(...)` returns:

- `label: string`
- `commandLines: string[]`
- `outputLines: string[]`
- `hiddenOutputLines: number`

This is intentionally frontend-agnostic: no ANSI codes, no box drawing, no terminal width math outside plain character wrapping.

CLI and web can both consume this same shape and render with their own skins.

### `formatBlock` vs `formatOutput`

Inside `bash.ts`, `formatBlock` uses an internal helper `formatOutput`.

- `formatOutput` is private and only formats output lines
- `formatBlock` is the public API and formats the full block (header + command + output)

If another frontend needs output-only formatting directly, export `formatOutput` later. For now, prefer `formatBlock` as the stable entrypoint.

## File tools modules (`src/tools/read.ts`, `write.ts`, `edit.ts`)

- Each module owns:
	- `definition`
	- `argsPreview`
	- `execute`
- Shared file behavior is in `src/tools/file-utils.ts`:
	- path resolution (`~/`, relative to cwd)
	- hashline formatting and ref validation
	- per-path async lock used by `write` and `edit`

`edit.execute` still uses runtime-controlled context size (from `tools.config.contextLines`), passed in by `src/runtime/tools.ts`.

## Streaming lifecycle (bash)

1. `src/runtime/agent-loop.ts`
	- Emits `tool` event with `phase: 'running'`
2. `src/tools/bash.ts` (`execute`)
	- Reads stdout chunks and calls `onChunk(chunk)`
3. `src/runtime/agent-loop.ts`
	- Converts each chunk into `tool` event with `phase: 'streaming'`
4. `src/client.ts`
	- Appends chunk text to the matching live tool block (`block.output += chunk`)
5. `src/cli/blocks.ts`
	- Re-renders and calls `bash.formatBlock(...)` on every frame
6. Completion
	- Runtime emits `phase: 'done' | 'error'` with final output
	- Client marks block done/error and replaces output with final text

## Persistence vs live behavior

- Streaming chunk events are live runtime events for attached clients.
- Session history persists final tool results (done/error), not every chunk.
- Replay/restored sessions therefore show final output, not live chunk timing.

## Shared-formatting rule for web/CLI parity

To keep output consistent across frontends:

- Put tool-specific formatting semantics in `src/tools/<tool>.ts`
- Keep frontend rendering concerns separate:
	- CLI: ANSI, box borders, cursor, truncation chrome
	- Web: DOM/CSS presentation

In short:

- `src/tools/*` decides **what** gets shown
- frontend layer decides **how** it is drawn

## Migration checklist for remaining tools

For each tool (`read_blob`, `grep`, `glob`, `ls`, `ask`, `eval`, ...):

1. Add `src/tools/<name>.ts` with:
	- `definition`
	- `argsPreview`
	- `execute`
	- `formatBlock` (if tool has custom formatting semantics)
2. Wire `src/runtime/tools.ts` to delegate schema/preview/execute
3. Update frontend block rendering to consume shared formatting when needed
4. Add focused tests under `src/tools/`

This keeps migration incremental and lowers risk while improving reuse.
