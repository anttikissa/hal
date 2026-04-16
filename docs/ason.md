# ASON — A Saner Object Notation

ASON is a superset of JSON designed for human-readable config and state files. Basically any JS
object literal should be valid ASON.

ASONL is similar to JSONL (newline-delimited ASON records)

Example:

```ason
{
	format: 'ason',
	features: [
		"strings", 'of many kinds', `including
backtick strings`,
		'unquoted keys', 'trailing commas',],
	numberFormats: [
		42, 3.14, .82, 1., -.5, +1, 0xFF, 1e10, 1_000_000, 42n, 0xFFn, Infinity, -Infinity, NaN
	],
	comments: {
		/* block comments /*
		like: 'the one above',
		// and inline comments
		are: 'just fine',
	}
}
```

```asonl
{ type: 'runtime-start', pid: 25090, startedAt: '2026-03-21T22:09:31.201Z' }
{ type: 'sessions', sessions: [{ id: '03-52i', name: 'tab 1' }] }
{ type: 'host-released' }
```

## Design goals

- Support all primitive JS objects (including BigInt, undefined, Infinity etc)
- Comments are supported and parse-stringify roundtrip preserves them (with some limitations)
- Human readable by default, compact mode is available when needed
- You can paste ASON into any JavaScript REPL
- Superset of JSON, JSONC, JSON5
- Reasonably fast TS reference implementation (cannot match native code, but it shouldn't be an
  order of magnitude slower) with no dependencies and under 500 lines of code
- Bonus: parse errors should be as helpful as possible

## API

`ason.parse(str)` parses an ASON string into a JavaScript value
`ason.parse(str, { comments: true })` also preserves comments as `[COMMENTS]` metadata
`ason.stringify(value)` print value with smart formatting (similar to prettier)
`ason.stringify(value, 'short')` prints a compact one-line representation of value
`ason.stringify(value, 'long')` prints a compact one-line representation of value
`ason.parseAll(str)` parses all ASON values from an ASONL file
`ason.parseStream(stream)` parses ASON values from a byte stream (ignoring first parse error if we
we started reading from the middle of an object)

The stringify methods print comments too if they are present, with some limitations (notably,
comments after the last element in an object or array are not preserved).

## Format

### Values

The parser accepts all JSON types, plus:

- Unquoted keys: `{ name: 'hal', version: 1 }` (including non-ASCII like `café`)
- Single-quoted strings: `'hello'`
- Backtick strings: `` `line1\nline2` `` — multiline, no interpolation
- JSON5-style string continuations and escapes: `'a\\\nb'`, `"\x41\u0042"`
- `undefined`
- `NaN`, `Infinity`, `-Infinity`, `+Infinity`, `+NaN`
- Hex numbers: `0xFF`
- Signed numbers: `+1`, `+.5`
- Trailing-dot numbers: `1.`
- Numeric separators: `1_000_000`, `0xFF_FF`, `1_0e1_0`
- BigInt literals: `42n`, `-42n`, `0xFFn`, `1_000_000n`
- String escapes: `\xNN`, `\v`, `\0`, line continuations
- Comments: `// line` and `/* block */`
- Trailing commas

Invalid:

```ason
{ a: 1 b: 2 }
[1 2 3]
```

## ASON vs ASONL

**ASON** (`.ason`) — a single value per file.

**ASONL** (`.asonl`) — multiple values, one per line. Each record must be written with
`stringify(value, 'short') + '\n'`.

Source: `src/utils/ason.ts`
