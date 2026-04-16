# ASON — A Saner Object Notation

ASON is a superset of JSON designed for human-readable config and state files. Basically any JS
object literal should be valid ASON.

```
{
	format: 'ason',
	features: [
		"strings", 'of many kinds', `including
backtick strings`,
		'unquoted keys', 'trailing commas',],
	numberFormats: [
		42, 3.14, .82, 1., -.5, +1, 0xFF, 1e10, 1_000_000, Infinity, -Infinity, NaN
	],
	comments: {
		/* block comments /*
		like: 'the one above',
		// and inline comments
		are: 'just fine',
	}
}
```


## Design goal

ASON should be **as JavaScript-compatible as practical** while staying simple to read,
write, diff, and stream.

That means:
- JS-style numbers: `42`, `3.14`, `.82`, `1.`, `-.5`, `+1`, `0xFF`, `1e10`, `1_000_000`, `Infinity`, `-Infinity`, `NaN`
- JS-style strings: single quotes, double quotes, and backticks, with `\xNN`, `\v`, `\0`, and line continuations
- JS-style object keys: unquoted identifiers (including non-ASCII like `café`) and `\uXXXX` escapes
- JS-style commas: **commas are required between items and properties**
- JS-style trailing commas: **allowed, never required**
- JS-style `undefined`

## Format

### Values

All JSON types, plus:
- Unquoted keys: `{ name: 'hal', version: 1 }` (including non-ASCII like `café`)
- Single-quoted strings: `'hello'`
- Backtick strings: `` `line1\nline2` `` — multiline, no interpolation
- `undefined`
- `NaN`, `Infinity`, `-Infinity`, `+Infinity`, `+NaN`
- Hex numbers: `0xFF`
- Signed numbers: `+1`, `+.5`
- Trailing-dot numbers: `1.`
- Numeric separators: `1_000_000`, `0xFF_FF`, `1_0e1_0`
- String escapes: `\xNN`, `\v`, `\0`, line continuations
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
