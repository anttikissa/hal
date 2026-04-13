# ASON — A Saner Object Notation

ASON is a superset of JSON designed for human-readable config and state files.
Any valid JSON file is valid ASON.

## Design goal

ASON should be **as JavaScript-compatible as practical** while staying simple to read,
write, diff, and stream.

That means:
- JS-style numbers: `42`, `3.14`, `.82`, `-.5`, `1e10`, `Infinity`, `-Infinity`, `NaN`
- JS-style strings: single quotes, double quotes, and backticks
- JS-style object keys: unquoted identifiers allowed
- JS-style commas: **commas are required between items and properties**
- JS-style trailing commas: **allowed, never required**
- JS-style `undefined`

## Format

### Values

All JSON types, plus:
- Unquoted keys: `{ name: 'hal', version: 1 }`
- Single-quoted strings: `'hello'`
- Backtick strings: `` `line1\nline2` `` — multiline, no interpolation
- `undefined`
- `NaN`, `Infinity`, `-Infinity`
- Comments: `// line` and `/* block */`
- Trailing commas

### Example

```ason
{
	// Main model for all sessions
	model: 'anthropic/claude-opus-4-6',
	theme: 'hal',
	debug: {
		tokens: { sys: true, spam: false },
	},
}
```

## Commas

Commas follow JavaScript rules:
- required between properties in objects
- required between items in arrays
- optional after the last property/item

Valid:
```ason
{ a: 1, b: 2 }
{ a: 1, b: 2, }
[1, 2, 3]
[1, 2, 3,]
```

Invalid:
```ason
{ a: 1 b: 2 }
[1 2 3]
```

## ASON vs ASONL

**ASON** (`.ason`) — a single value per file.

**ASONL** (`.asonl`) — multiple values, one per line. Each record must be written with
`stringify(value, 'short') + '\n'`.

## Comment preservation

`parse(str, { comments: true })` preserves comments as `[COMMENTS]` metadata.

## API

```ts
parse(str)                          // AsonValue
parse(str, { comments: true })      // AsonValue with [COMMENTS]
parseAll(str)                       // AsonValue[]
parseStream(stream)                 // AsyncGenerator<AsonValue>
stringify(value)                    // smart mode
stringify(value, 'short')           // one line
stringify(value, 'long')            // always expanded
```

Source: `src/utils/ason.ts`
