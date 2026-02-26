# ASON — A Saner Object Notation

ASON is a superset of JSON designed for human-readable config and log files.
Any valid JSON or JSONL file is valid ASON.

## Format

### Values

All JSON types, plus:
- **Unquoted keys**: `{ name: 'hal', version: 1 }` — keys matching `/^[a-zA-Z_$][a-zA-Z0-9_$]*$/` don't need quotes.
- **Single-quoted strings**: `'hello'` — preferred over double quotes (double quotes used when the string contains single quotes).
- **`undefined`**: a first-class value (unlike JSON).
- **`NaN`, `Infinity`, `-Infinity`**: supported as number literals.
- **Comments**: `// line` and `/* block */` — ignored during parse unless `{ comments: true }`.
- **Trailing commas**: allowed in objects and arrays.

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

`stringify(value, mode)` formats values with prettier-like line wrapping:

| Mode | Behavior |
|------|----------|
| `'smart'` (default) | Inline if ≤80 cols, otherwise expanded with 2-space indent |
| `'short'` | Always single line, no comments |
| `'long'` | Always expanded |

Comments attached via `[COMMENTS]` are emitted in `smart` and `long` modes.

## Streaming (JSONL-style)

ASON files can contain multiple values, one per line — like JSONL.
Used for append-only logs (`prompts.ason`, IPC files).

- `parseAll(str)` — parse all values from a string.
- `parseStream(stream)` — async generator from a `ReadableStream<Uint8Array>`. The first line silently ignores parse errors (supports reading from mid-stream).

## Comment preservation

`parse(str, { comments: true })` attaches comments to the parsed result as symbol-keyed metadata.

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

### How it works

- **Objects**: `obj[COMMENTS]` is a `Record<string, string>` mapping key → comment text.
- **Arrays**: `arr[COMMENTS]` is a sparse `(string | undefined)[]` mapping index → comment text.
- **Blank lines**: A blank line before a comment is encoded as a leading `\n` in the comment string.
- Comments between a value and the next key/element attach to the next key/element.
- Only comments *before* keys/elements survive roundtrip. Trailing comments are lost.

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

```ts
// Parse
parse(str)                          → AsonValue
parse(str, { comments: true })      → AsonValue (with [COMMENTS] metadata)
parseAll(str)                       → AsonValue[]
parseStream(stream)                 → AsyncGenerator<AsonValue>

// Stringify
stringify(value)                    → string (smart mode, 80-col wrap)
stringify(value, 'short')           → string (single line, no comments)
stringify(value, 'long')            → string (always expanded)

// Comment symbol
COMMENTS                            → Symbol('comments')
```

## Implementation

Source: `src/utils/ason.ts` (~360 lines). Tests: `src/utils/ason.test.ts`.
