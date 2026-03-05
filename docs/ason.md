# ASON — A Saner Object Notation

ASON is a superset of JSON designed for human-readable config and state files.
Any valid JSON file is valid ASON.

## Format

### Values

All JSON types, plus:
- Unquoted keys: `{ name: 'hal', version: 1 }` — alphanumeric keys don't need quotes
- Single-quoted strings: `'hello'` — prefers double quotes when string contains single quotes
- Backtick strings: `` `line1\nline2` `` — multiline, like JS template literals (no interpolation; unescaped `${` is an error). Used in `smart`/`long` modes for strings containing newlines; `short` mode always uses escaped single-line strings.
- `undefined` literal
- Number literals `NaN`, `Infinity`, `-Infinity` supported
- Comments: `// line` and `/* block */` — survive parse/stringify roundtrip with `{ comments: true }`
- Trailing commas allowed

### Example

```
{
  // Main model for all sessions
  model: 'anthropic/claude-opus-4-6',
  theme: 'hal',
  debug: {
    tokens: { sys: true, spam: false }
  }
}
```

## Stringify modes

Given `const obj = { model: 'anthropic/claude-opus-4-6', theme: 'hal', debug: { tokens: { sys: true, spam: false } } }`:

`stringify(obj)` — smart (default): inline if ≤80 cols, otherwise expanded. Emits comments.
```
{
  model: 'anthropic/claude-opus-4-6',
  theme: 'hal',
  debug: { tokens: { sys: true, spam: false } }
}
```

`stringify(obj, 'short')` — always single line, no comments.
```
{ model: 'anthropic/claude-opus-4-6', theme: 'hal', debug: { tokens: { sys: true, spam: false } } }
```

`stringify(obj, 'long')` — always expanded. Emits comments.
```
{
  model: 'anthropic/claude-opus-4-6',
  theme: 'hal',
  debug: {
    tokens: {
      sys: true,
      spam: false
    }
  }
}
```

## ASON vs ASONL

**ASON** (`.ason`) — a single value per file. Used for config, state, and metadata. Written with `stringify(value)` (any mode) + `'\n'`.

Examples: `config.ason`, `auth.ason`, `index.ason`, `info.ason`, `state.ason`, `calibration.ason`, `themes/*.ason`.

**ASONL** (`.asonl`) — multiple values, one per line (like JSONL). Used for append-only logs and message streams. Each record **must** be produced with `stringify(value, 'short') + '\n'` — multi-line records would break line-oriented parsing.

Examples: `messages.asonl`, `commands.asonl`, `events.asonl`, `tool-calls.asonl`, `responses.asonl`, debug logs.

### ASONL API

- `parseAll(str)` — parse all values from a string.
- `parseStream(stream)` — async generator from a `ReadableStream<Uint8Array>`. Reading from mid-stream is supported (ignores parse errors on the first line).

## Comment preservation

`parse(str, { comments: true })` attaches comments to the parsed result as symbol-keyed metadata.
Trailing comments and comments outside the root value are lost (sorry!).

```ts
import { parse, stringify, COMMENTS } from './src/utils/ason.ts'

const obj = parse(`{
  // the port
  port: 3000,
  host: 'localhost'
}`, { comments: true })

obj[COMMENTS]  // { port: '// the port\n' }

stringify(obj)
// {
//   // the port
//   port: 3000,
//   host: 'localhost'
// }
```

## Types

```ts
type AsonValue =
  | string | number | boolean | null | undefined
  | AsonArray
  | AsonObject

type AsonArray = AsonValue[] & { [COMMENTS]?: (string | undefined)[] }
type AsonObject = { [key: string]: AsonValue; [COMMENTS]?: Record<string, string> }
```

## API

```
// Parse
parse(str)                          → AsonValue
parse(str, { comments: true })      → AsonValue (with [COMMENTS] metadata)
parseAll(str)                       → AsonValue[]
parseStream(stream)                 → AsyncGenerator<AsonValue>

// Stringify
stringify(value)                    → string (smart mode, 80-col wrap)
stringify(value, 'short')           → string (single line, no comments)
stringify(value, 'long')            → string (always expanded)
```

## Implementation

Source: `src/utils/ason.ts` (~350 lines). Tests: `src/utils/ason.test.ts`.
