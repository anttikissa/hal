# ASON — A Saner Object Notation

ASON is a superset of JSON designed for human-readable config and log files.
Any valid JSON or JSONL file is valid ASON.

## Format

### Values

All JSON types, plus:
- Unquoted keys: `{ name: 'hal', version: 1 }` — alphanumeric keys don't need quotes
- Single-quoted strings: `'hello'` — prefers double quotes in cases like "it's"
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

## Streaming (JSONL-style)

ASON files can contain multiple values, one per line — like JSONL.
Used for append-only logs (`prompts.ason`, IPC files).

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
  | string | number | boolean | null
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
