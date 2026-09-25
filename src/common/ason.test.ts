import { describe, test, expect } from 'bun:test'
import { ason, type ParseError } from './ason.ts'

let { stringify, parse, parseAll } = ason

function parseError(src: string): ParseError {
	try {
		parse(src)
	} catch (e) {
		return e as ParseError
	}
	throw new Error(`expected parse to fail: ${src}`)
}

describe('stringify', () => {
	test('primitives', () => {
		expect(stringify(null)).toBe('null')
		expect(stringify(undefined)).toBe('undefined')
		expect(stringify(true)).toBe('true')
		expect(stringify(-1.5)).toBe('-1.5')
		expect(stringify(NaN)).toBe('NaN')
		expect(stringify(-Infinity)).toBe('-Infinity')
		expect(stringify(42n)).toBe('42n')
		expect(stringify(-42n)).toBe('-42n')
	})

	test('strings prefer single quotes, double when containing only single', () => {
		expect(stringify('hi')).toBe("'hi'")
		expect(stringify("it's")).toBe(`"it's"`)
		expect(stringify(`it's "x"`)).toBe(`'it\\'s "x"'`)
		expect(stringify('a\\b\tc')).toBe("'a\\\\b\\tc'")
	})

	test('multiline strings use backticks in smart mode, escapes in short', () => {
		expect(stringify('line1\nline2')).toBe('`line1\nline2`')
		expect(stringify('cost: ${x}\n`q`')).toBe('`cost: \\${x}\n\\`q\\``')
		expect(stringify('a\nb', 'short')).toBe("'a\\nb'")
	})

	test('keys are quoted only when not identifiers', () => {
		expect(stringify({ '*': 1, a_b: 2, $c: 3, '1x': 4 })).toBe("{ '*': 1, a_b: 2, $c: 3, '1x': 4 }")
	})

	test('empty collections', () => {
		expect(stringify([])).toBe('[]')
		expect(stringify({})).toBe('{}')
		expect(stringify({ a: [], b: {} }, 'long')).toBe('{\n\ta: [],\n\tb: {}\n}')
	})

	test('smart mode stays inline within 80 columns', () => {
		expect(stringify({ a: 1, b: [1, 2], c: { d: 'x' } })).toBe("{ a: 1, b: [1, 2], c: { d: 'x' } }")
	})

	test('smart mode wraps only the levels that overflow, with tabs', () => {
		let value = { name: 'alice', email: 'alice@example.com', tags: ['admin', 'user', 'moderator'], extra: 'x'.repeat(20) }
		expect(stringify(value)).toBe(
			"{\n\tname: 'alice',\n\temail: 'alice@example.com',\n\ttags: ['admin', 'user', 'moderator'],\n\textra: 'xxxxxxxxxxxxxxxxxxxx'\n}",
		)
	})

	test('short mode is always one line', () => {
		let value = { a: 'x'.repeat(100), b: [1, { c: 2 }] }
		expect(stringify(value, 'short')).toBe(`{ a: '${'x'.repeat(100)}', b: [1, { c: 2 }] }`)
	})

	test('long mode always expands', () => {
		expect(stringify({ a: [1, { b: 2 }] }, 'long')).toBe('{\n\ta: [\n\t\t1,\n\t\t{\n\t\t\tb: 2\n\t\t}\n\t]\n}')
	})

	test('long mode visits each nested value once', () => {
		let reads = 0
		let value: unknown = 1
		for (let depth = 0; depth < 12; depth++) {
			let child = value
			value = Object.defineProperty({}, 'next', {
				enumerable: true,
				get: () => {
					reads++
					return child
				},
			})
		}
		stringify(value, 'long')
		expect(reads).toBe(12)
	})

	test('unsupported values throw', () => {
		expect(() => stringify(() => 1)).toThrow(/function/)
		expect(() => stringify(Symbol('x'))).toThrow(/symbol/)
	})
})

describe('parse', () => {
	test('numbers', () => {
		expect(parse('3.14')).toBe(3.14)
		expect(parse('.82')).toBe(0.82)
		expect(parse('1.')).toBe(1)
		expect(parse('-.5')).toBe(-0.5)
		expect(parse('+1')).toBe(1)
		expect(parse('1e10')).toBe(1e10)
		expect(parse('0xFF')).toBe(255)
		expect(parse('-0xff')).toBe(-255)
		expect(parse('1_000_000')).toBe(1000000)
		expect(parse('0xFF_FF')).toBe(0xffff)
		expect(parse('1_0e1_0')).toBe(10e10)
		expect(parse('Infinity')).toBe(Infinity)
		expect(parse('-Infinity')).toBe(-Infinity)
		expect(parse('+Infinity')).toBe(Infinity)
		expect(parse('NaN')).toBeNaN()
		expect(parse('+NaN')).toBeNaN()
	})

	test('bigints', () => {
		expect(parse('42n')).toBe(42n)
		expect(parse('-42n')).toBe(-42n)
		expect(parse('0xFFn')).toBe(255n)
		expect(parse('-0xFFn')).toBe(-255n)
		expect(parse('1_000_000n')).toBe(1000000n)
	})

	test('keywords', () => {
		expect(parse('true')).toBe(true)
		expect(parse('false')).toBe(false)
		expect(parse('null')).toBe(null)
		expect(parse('undefined')).toBe(undefined)
	})

	test('strings and escapes', () => {
		expect(parse(`'a\\nb\\tc'`)).toBe('a\nb\tc')
		expect(parse(`"\\x41\\u0042"`)).toBe('AB')
		expect(parse(`'\\v\\0\\b\\f\\q'`)).toBe('\v\0\b\fq')
		expect(parse(`'a\\\nb'`)).toBe('ab')
		expect(parse(`'a\\\r\nb'`)).toBe('ab')
		expect(parse('`line1\nline2`')).toBe('line1\nline2')
		expect(parse('`cost: \\${x}`')).toBe('cost: ${x}')
	})

	test('objects and arrays', () => {
		expect(parse("{ x: 1, 'y z': 2, \"w\": 3, café: 4, }")).toEqual({ x: 1, 'y z': 2, w: 3, café: 4 })
		expect(parse("[1, null, 'hello',]")).toEqual([1, null, 'hello'])
		expect(parse('{ a: undefined }')).toEqual({ a: undefined })
		expect(parse('{\n\tname: "hal",\n\tlist: [\n\t\t1,\n\t],\n}')).toEqual({ name: 'hal', list: [1] })
	})

	test('comments are skipped', () => {
		expect(parse('{ a: /* the val */ 1 } // done')).toEqual({ a: 1 })
		expect(parse('// head\n[1, // one\n2]')).toEqual([1, 2])
		expect(parse('/* a /* b */ 42')).toBe(42)
	})

	test('accepts JSON', () => {
		let json = JSON.stringify({ a: [1, 2.5, 'x', null, true], b: { 'c d': 'e"f' } }, null, 2)
		expect(parse(json)).toEqual(JSON.parse(json))
	})

	test('the ason.md example', () => {
		let src = `{
	format: 'ason',
	features: [
		"strings", 'of many kinds', \`including
backtick strings\`,
		'unquoted keys', 'trailing commas',],
	numberFormats: [
		42, 3.14, .82, 1., -.5, +1, 0xFF, 1e10, 1_000_000, 42n, 0xFFn, Infinity, -Infinity, NaN
	],
	comments: {
		/* block comments */
		like: 'the one above',
		// and inline comments
		are: 'just fine',
	}
}`
		expect(parse(src)).toEqual({
			format: 'ason',
			features: ['strings', 'of many kinds', 'including\nbacktick strings', 'unquoted keys', 'trailing commas'],
			numberFormats: [42, 3.14, 0.82, 1, -0.5, 1, 255, 1e10, 1000000, 42n, 255n, Infinity, -Infinity, NaN],
			comments: { like: 'the one above', are: 'just fine' },
		})
	})
})

describe('parse errors', () => {
	test('invalid input throws with line, column, source line and caret', () => {
		let e = parseError('tru')
		expect(e.message).toBe("Expected 'e', got 'EOF' at 1:4:\n    tru\n       ^")
		expect(e.pos).toBe(3)
	})

	test('caret aligns with tabs', () => {
		let e = parseError('{\n\tfoo: bar\n}\n')
		expect(e.message).toBe("Unexpected token at 2:7:\n    \tfoo: bar\n    \t     ^")
		expect(e.pos).toBe(8)
	})

	test('missing separators are rejected', () => {
		expect(parseError('{ a: 1 b: 2 }').pos).toBe(7)
		expect(parseError('[1 2 3]').pos).toBe(3)
		expect(parseError('[1 2 3]').message).toMatch(/^Expected ',' or '\]'/)
	})

	test('each invalid input reports where it failed', () => {
		let cases: [string, RegExp, number][] = [
			[`'abc`, /Unterminated string/, 4],
			['`${x}`', /interpolation/, 1],
			[`'\\u00'`, /Invalid unicode escape/, 2],
			[`'\\uXXXX'`, /Invalid unicode escape/, 2],
			[`'\\xG1'`, /Invalid hex escape/, 2],
			['1 2', /Unexpected content after value/, 2],
			['nulls', /Unexpected character after 'null'/, 4],
			['{ : 1 }', /Expected object key/, 2],
			['{ a 1 }', /Expected ':'/, 4],
			['[1, 2', /Expected ',' or '\]'/, 5],
			['', /Unexpected token/, 0],
			['@', /Unexpected token/, 0],
			['1 /* open', /Unterminated comment/, 2],
		]
		for (let [src, msg, pos] of cases) {
			let e = parseError(src)
			expect(e.message).toMatch(msg)
			expect(e.pos).toBe(pos)
		}
	})
})

describe('round trip', () => {
	let values: unknown[] = [
		null,
		undefined,
		0,
		-0.5,
		1e300,
		Infinity,
		-Infinity,
		123456789012345678901234567890n,
		'',
		"it's",
		'both \' and "',
		'multi\nline with ` and ${x} and \\',
		'tab\tcr\r',
		'unicode é ✓ 🙂',
		[],
		{},
		{ 'odd key': [1, [2, [3]]], nested: { deep: { deeper: 'x'.repeat(90) } } },
		Array.from({ length: 30 }, (_, i) => ({ i, s: `item ${i}` })),
	]

	for (let mode of ['smart', 'short', 'long'] as const) {
		test(`stringify then parse is identity (${mode})`, () => {
			for (let value of values) expect(parse(stringify(value, mode))).toEqual(value as any)
		})
	}

	test('NaN round trips', () => expect(parse(stringify(NaN))).toBeNaN())
})

describe('ASONL', () => {
	test('short records are one line each and parse back in order', () => {
		let records = [{ type: 'start', pid: 1 }, { text: 'a\nb', big: 2n }, [1, 2], 'plain']
		let file = records.map((r) => ason.stringifyLine(r)).join('')
		expect(file).toBe("{ type: 'start', pid: 1 }\n{ text: 'a\\nb', big: 2n }\n[1, 2]\n'plain'\n")
		expect(parseAll(file)).toEqual(records)
	})

	test('parseAll accepts multiline records, comments and blank lines', () => {
		expect(parseAll('{\n\ta: 1,\n}\n\n// note\n{\n\tb: 2,\n}\n')).toEqual([{ a: 1 }, { b: 2 }])
		expect(parseAll('')).toEqual([])
	})

	test('parseAll reports position of the bad record', () => {
		let src = '{ a: 1 }\n{ b: @ }\n'
		let e = (() => {
			try {
				parseAll(src)
			} catch (e) {
				return e as ParseError
			}
		})()
		expect(e?.pos).toBe(src.indexOf('@'))
		expect(e?.message).toContain('2:6')
	})
})
