import { describe, test, expect } from 'bun:test'
import { stringify, parse, parseAll, parseStream, COMMENTS } from './ason'

describe('stringify', () => {
	describe('primitives', () => {
		test('null', () => expect(stringify(null)).toBe('null'))
		test('undefined', () => expect(stringify(undefined)).toBe('undefined'))
		test('true', () => expect(stringify(true)).toBe('true'))
		test('false', () => expect(stringify(false)).toBe('false'))
		test('zero', () => expect(stringify(0)).toBe('0'))
		test('integer', () => expect(stringify(42)).toBe('42'))
		test('negative', () => expect(stringify(-3.14)).toBe('-3.14'))
		test('NaN', () => expect(stringify(NaN)).toBe('NaN'))
		test('Infinity', () => expect(stringify(Infinity)).toBe('Infinity'))
		test('-Infinity', () => expect(stringify(-Infinity)).toBe('-Infinity'))
		test('simple string', () => expect(stringify('hello')).toBe("'hello'"))
		test('empty string', () => expect(stringify('')).toBe("''"))
		test('string with newline', () => expect(stringify('a\nb')).toBe("'a\\nb'"))
		test('string with tab', () => expect(stringify('a\tb')).toBe("'a\\tb'"))
		test('string with backslash', () => expect(stringify('a\\b')).toBe("'a\\\\b'"))
	})

	describe('string quoting', () => {
		test('single quote in string → double quotes', () =>
			expect(stringify("it's")).toBe('"it\'s"'))
		test('double quote in string → single quotes', () =>
			expect(stringify('she said "hi"')).toBe('\'she said "hi"\''))
		test('both quotes → single quotes, escape single', () =>
			expect(stringify(`she said "it's fine"`)).toBe("'she said \"it\\'s fine\"'"))
	})

	describe('objects', () => {
		test('empty object', () => expect(stringify({})).toBe('{}'))
		test('simple object', () => expect(stringify({ x: 123 })).toBe('{ x: 123 }'))
		test('non-identifier key', () => expect(stringify({ '*': 123 })).toBe("{ '*': 123 }"))
		test('key with spaces', () => expect(stringify({ 'foo bar': 1 })).toBe("{ 'foo bar': 1 }"))
		test('key with dash', () => expect(stringify({ 'x-y': 1 })).toBe("{ 'x-y': 1 }"))
		test('numeric key', () => expect(stringify({ '0': true })).toBe("{ '0': true }"))
		test('multiple keys', () => expect(stringify({ a: 1, b: 2 })).toBe('{ a: 1, b: 2 }'))
		test('nested object (inline)', () =>
			expect(stringify({ a: { b: 1 } })).toBe('{ a: { b: 1 } }'))
		test('object with mixed values', () =>
			expect(stringify({ name: 'hal', version: 1 })).toBe("{ name: 'hal', version: 1 }"))
		test('wide object breaks lines', () => {
			const obj = {
				alpha: 'something long',
				beta: 'another thing',
				gamma: 'third value',
				delta: 'fourth item',
			}
			expect(stringify(obj)).toBe(
				"{\n  alpha: 'something long',\n  beta: 'another thing',\n  gamma: 'third value',\n  delta: 'fourth item'\n}",
			)
		})

		test('nested wide object', () => {
			const obj = {
				outer: { alpha: 'something', beta: 'another', gamma: 'third', delta: 'fourth' },
			}
			expect(stringify(obj)).toBe(
				"{\n  outer: {\n    alpha: 'something',\n    beta: 'another',\n    gamma: 'third',\n    delta: 'fourth'\n  }\n}",
			)
		})
		test('nested stays inline if short', () => {
			expect(stringify({ a: { b: { c: 1 } } })).toBe('{ a: { b: { c: 1 } } }')
		})
	})

	describe('arrays', () => {
		test('empty array', () => expect(stringify([])).toBe('[]'))
		test('simple array', () => expect(stringify([1, 2, 3])).toBe('[1, 2, 3]'))
		test('mixed types', () => expect(stringify([1, null, 'this'])).toBe("[1, null, 'this']"))
		test('nested object in array', () => {
			expect(stringify([1, null, 'this', { object: [1, 2, 3] }])).toBe(
				"[1, null, 'this', { object: [1, 2, 3] }]",
			)
		})
		test('wide array breaks lines', () => {
			const obj = [
				'something longer',
				'another thing here',
				'third value is big',
				'fourth item too',
			]
			expect(stringify(obj)).toBe(
				"[\n  'something longer',\n  'another thing here',\n  'third value is big',\n  'fourth item too'\n]",
			)
		})
		test('array of objects', () => {
			expect(stringify([{ a: 1 }, { b: 2 }])).toBe('[{ a: 1 }, { b: 2 }]')
		})
		test('wide array of objects breaks lines', () => {
			const obj = [
				{ name: 'alice', score: 100 },
				{ name: 'bob', score: 200 },
				{ name: 'charlie', score: 300 },
			]
			expect(stringify(obj)).toBe(
				"[\n  { name: 'alice', score: 100 },\n  { name: 'bob', score: 200 },\n  { name: 'charlie', score: 300 }\n]",
			)
		})
	})
})

describe('stringify modes', () => {
	const wide = {
		name: 'alice',
		email: 'alice@example.com',
		score: 100,
		tags: ['admin', 'user', 'moderator'],
	}

	test('short is always single-line', () => {
		const result = stringify(wide, 'short')
		expect(result).not.toContain('\n')
		expect(result).toContain("name: 'alice'")
	})

	test('smart breaks wide objects to multi-line', () => {
		const result = stringify(wide, 'smart')
		expect(result).toContain('\n')
	})

	test('smart keeps narrow objects inline', () => {
		expect(stringify({ a: 1 }, 'smart')).toBe('{ a: 1 }')
	})

	test('long always uses multi-line', () => {
		const result = stringify({ a: 1 }, 'long')
		expect(result).toContain('\n')
		expect(result).toBe('{\n  a: 1\n}')
	})

	test('default is smart', () => {
		expect(stringify(wide)).toBe(stringify(wide, 'smart'))
	})
})



describe('parse', () => {
	describe('primitives', () => {
		test('null', () => expect(parse('null')).toBe(null))
		test('undefined', () => expect(parse('undefined')).toBe(undefined))
		test('true', () => expect(parse('true')).toBe(true))
		test('false', () => expect(parse('false')).toBe(false))
		test('integer', () => expect(parse('42')).toBe(42))
		test('zero', () => expect(parse('0')).toBe(0))
		test('negative integer', () => expect(parse('-1')).toBe(-1))
		test('float', () => expect(parse('3.14')).toBe(3.14))
		test('negative float', () => expect(parse('-3.14')).toBe(-3.14))
		test('invalid: leading decimal', () => expect(() => parse('-.5')).toThrow())
		test('invalid: trailing dot', () => expect(() => parse('1.')).toThrow())

		test('scientific notation', () => expect(parse('1e10')).toBe(1e10))
		test('scientific uppercase', () => expect(parse('1E10')).toBe(1e10))
		test('scientific positive exponent', () => expect(parse('1e+10')).toBe(1e10))
		test('scientific negative exponent', () => expect(parse('1e-10')).toBe(1e-10))
		test('float with exponent', () => expect(parse('1.5e2')).toBe(150))
		test('negative float with exponent', () => expect(parse('-1.5e-2')).toBe(-0.015))
		test('invalid: double dot', () => expect(() => parse('1.2.3')).toThrow())
		test('invalid: bare minus', () => expect(() => parse('-')).toThrow())
		test('invalid: missing exponent', () => expect(() => parse('1e')).toThrow())
		test('invalid: missing exponent digits', () => expect(() => parse('1e+')).toThrow())

		test('NaN', () => expect(parse('NaN')).toBeNaN())
		test('Infinity', () => expect(parse('Infinity')).toBe(Infinity))
		test('-Infinity', () => expect(parse('-Infinity')).toBe(-Infinity))
		test('single-quoted string', () => expect(parse("'hello'")).toBe('hello'))
		test('double-quoted string', () => expect(parse('"hello"')).toBe('hello'))
		test('string with escapes', () => expect(parse("'a\\nb\\tc'")).toBe('a\nb\tc'))
		test('string with escaped quote', () => expect(parse("'it\\'s'")).toBe("it's"))
		test('double-quoted with single inside', () => expect(parse('"it\'s"')).toBe("it's"))
		test('string with backspace escape', () => expect(parse("'a\\bc'")).toBe('a\bc'))
		test('string with form feed escape', () => expect(parse("'a\\fc'")).toBe('a\fc'))
		test('string with unicode escape', () => expect(parse("'\\u0041'")).toBe('A'))
		test('string with unicode accented char', () => expect(parse("'caf\\u00e9'")).toBe('café'))
		test('string with unicode CJK', () => expect(parse("'\\u4e16'")).toBe('世'))
		test('invalid unicode escape: too short', () => expect(() => parse("'\\u00'")).toThrow(/Invalid unicode escape/))
		test('invalid unicode escape: bad hex', () => expect(() => parse("'\\uXXXX'")).toThrow(/Invalid unicode escape/))
	})

	describe('objects', () => {
		test('empty object', () => expect(parse('{}')).toEqual({}))
		test('unquoted keys', () => expect(parse('{ x: 123 }')).toEqual({ x: 123 }))
		test('quoted keys', () => expect(parse("{ '*': 123 }")).toEqual({ '*': 123 }))
		test('multiple keys', () => expect(parse('{ a: 1, b: 2 }')).toEqual({ a: 1, b: 2 }))
		test('nested object', () => expect(parse('{ a: { b: 1 } }')).toEqual({ a: { b: 1 } }))
		test('trailing comma', () => expect(parse('{ a: 1, b: 2, }')).toEqual({ a: 1, b: 2 }))
	})

	describe('arrays', () => {
		test('empty array', () => expect(parse('[]')).toEqual([]))
		test('simple array', () => expect(parse('[1, 2, 3]')).toEqual([1, 2, 3]))
		test('mixed types', () => expect(parse("[1, null, 'hello']")).toEqual([1, null, 'hello']))
		test('nested', () =>
			expect(parse('[[1, 2], [3, 4]]')).toEqual([
				[1, 2],
				[3, 4],
			]))
		test('trailing comma', () => expect(parse('[1, 2, 3,]')).toEqual([1, 2, 3]))
	})

	describe('comments', () => {
		test('line comment after value', () => expect(parse('42 // the answer')).toBe(42))
		test('block comment before value', () => expect(parse('/* hi */ 42')).toBe(42))
		test('block comment inline', () =>
			expect(parse('{ a: /* the val */ 1 }')).toEqual({ a: 1 }))
		test('comment in object', () =>
			expect(parse('{ a: 1, // comment\n b: 2 }')).toEqual({ a: 1, b: 2 }))
		test('comment-only lines in multiline', () => {
			expect(
				parse(`{
	// this is a config
	name: 'hal',
	/* version field */
	version: 1,
}`),
			).toEqual({ name: 'hal', version: 1 })
		})
		test('comment between array items', () => {
			expect(
				parse(`[
	1, // first
	2, // second
	3, // third
]`),
			).toEqual([1, 2, 3])
		})
		test('nested block comments do not nest', () => {
			// /* ... */ does not nest — first */ closes it
			expect(parse('/* a /* b */ 42')).toBe(42)
		})
		test('line comment does not affect next line', () => {
			expect(parse("// ignore this\n'real value'")).toBe('real value')
		})
	})

	describe('multiline', () => {
		test('multiline object', () => {
			expect(
				parse(`{
	name: 'hal',
	version: 1,
}`),
			).toEqual({ name: 'hal', version: 1 })
		})
	})

	describe('JSON compat', () => {
		test('double-quoted keys', () =>
			expect(parse('{ "name": "hal" }')).toEqual({ name: 'hal' }))
		test('standard JSON', () => expect(parse('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] }))
	})

	describe('errors', () => {
		test('unexpected token', () => {
			expect(() => parse('tru')).toThrow(/Expected 'e', got 'EOF'/)
			expect(() => parse('tru')).toThrow(/tru/)
			expect(() => parse('tru')).toThrow(/\^/)
		})
		test('error points to right column', () => {
			try {
				parse('{ value: tru }')
				throw new Error('should have thrown')
			} catch (e: any) {
				expect(e.message).toContain('1:13')
				expect(e.message).toContain("Expected 'e', got ' '")
				expect(e.message).toContain('value: tru }')

			}
		})
		test('error on correct line and column', () => {
			try {
				parse('{\n  a: 1,\n  b: tru,\n}')
				throw new Error('should have thrown')
			} catch (e: any) {
				expect(e.message).toContain('3:9')
				expect(e.message).toContain("Expected 'e', got ','")
				expect(e.message).toContain('b: tru,')

			}
		})
		test('error caret aligns with tabs', () => {
			try {
				parse('{\n\tfoo: bar\n}\n')
				throw new Error('should have thrown')
			} catch (e: any) {
				expect(e.message).toContain('2:7')
				expect(e.message).toMatch(/\n {4}\t {5}\^/)
			}
		})
		test('mistyped keywords', () => {
			expect(() => parse('nulls')).toThrow(/Unexpected character after 'null' at 1:5/)
			expect(() => parse('tru')).toThrow(/Expected 'e', got 'EOF' at 1:4/)
			expect(() => parse('truee')).toThrow(/Unexpected character after 'true' at 1:5/)
			expect(() => parse('fals')).toThrow(/Expected 'e', got 'EOF' at 1:5/)
			expect(() => parse('undefinedd')).toThrow(/Unexpected character after 'undefined' at 1:10/)
			expect(() => parse('-Infinityx')).toThrow(/Unexpected character after '-Infinity' at 1:10/)
			expect(() => parse('NaNx')).toThrow(/Unexpected character after 'NaN' at 1:4/)
		})
	})
})

describe('parseAll', () => {
	test('single value', () => expect(parseAll('42')).toEqual([42]))
	test('multiple values on separate lines', () => {
		expect(parseAll('1\n2\n3')).toEqual([1, 2, 3])
	})
	test('mixed types', () => {
		expect(parseAll("'hello'\n42\nnull")).toEqual(['hello', 42, null])
	})
	test('objects on separate lines (JSONL style)', () => {
		expect(parseAll('{ a: 1 }\n{ b: 2 }\n{ c: 3 }')).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
	})
	test('multiline objects', () => {
		expect(
			parseAll(`{
	a: 1,
}
{
	b: 2,
}`),
		).toEqual([{ a: 1 }, { b: 2 }])
	})
	test('blank lines and comments between values', () => {
		expect(
			parseAll(`
// first
42

// second
'hello'

`),
		).toEqual([42, 'hello'])
	})
	test('empty string', () => expect(parseAll('')).toEqual([]))
	test('only whitespace and comments', () => expect(parseAll('  // nothing\n  ')).toEqual([]))
	test('standard JSONL', () => {
		expect(parseAll('{"a":1}\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }])
	})
})

describe('parseStream', () => {
	function toStream(chunks: string[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder()
		return new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
				controller.close()
			},
		})
	}

	async function collect(stream: ReadableStream<Uint8Array>): Promise<any[]> {
		const results: any[] = []
		for await (const value of parseStream(stream)) results.push(value)
		return results
	}

	test('single line', async () => {
		expect(await collect(toStream(["{ a: 1 }\n"]))).toEqual([{ a: 1 }])
	})

	test('multiple lines', async () => {
		expect(await collect(toStream(['{ a: 1 }\n{ b: 2 }\n']))).toEqual([{ a: 1 }, { b: 2 }])
	})

	test('line split across chunks', async () => {
		expect(await collect(toStream(['{ a:', ' 1 }\n']))).toEqual([{ a: 1 }])
	})

	test('multiple chunks multiple values', async () => {
		expect(await collect(toStream(['{ a: 1 }\n{ b', ': 2 }\n{ c: 3 }\n']))).toEqual([
			{ a: 1 },
			{ b: 2 },
			{ c: 3 },
		])
	})

	test('empty stream', async () => {
		expect(await collect(toStream([]))).toEqual([])
	})

	test('trailing value without newline', async () => {
		expect(await collect(toStream(['{ a: 1 }']))).toEqual([{ a: 1 }])
	})

	test('blank lines are skipped', async () => {
		expect(await collect(toStream(['{ a: 1 }\n\n\n{ b: 2 }\n']))).toEqual([{ a: 1 }, { b: 2 }])
	})

	test('invalid first line is silently skipped', async () => {
		expect(await collect(toStream(['{ a: @@@ }\n{ b: 2 }']))).toEqual([{b: 2}])
	})

	test('first line partial record is silently skipped', async () => {
		expect(await collect(toStream(['artial }\n{ a: 1 }\n']))).toEqual([{ a: 1 }])
	})

	test('first line partial record with valid records after', async () => {
		expect(await collect(toStream(['{ x: 1 } }\n{ a: 1 }\n{ b: 2 }\n']))).toEqual([{ a: 1 }, { b: 2 }])
	})

	test('first line valid record is not skipped', async () => {
		expect(await collect(toStream(['{ a: 1 }\n{ b: 2 }\n']))).toEqual([{ a: 1 }, { b: 2 }])
	})

	test('second line invalid still throws', async () => {
		const iter = parseStream(toStream(['{ a: 1 }\n@@@\n']))
		const first = await iter.next()
		expect(first.value).toEqual({ a: 1 })
		expect(iter.next()).rejects.toThrow(/Unexpected token/)
	})

	test('yields immediately on newline-terminated record', async () => {
		const encoder = new TextEncoder()
		let controller: ReadableStreamDefaultController<Uint8Array> | null = null
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c
			},
		})

		const iter = parseStream(stream)
		controller!.enqueue(encoder.encode("{ event: 'keypress', data: 'a' }\n"))

		const result = await Promise.race([
			iter.next(),
			Bun.sleep(50).then(() => ({ timeout: true }) as const),
		])

		expect('timeout' in result).toBe(false)
		if (!('timeout' in result)) {
			expect(result.done).toBe(false)
			expect(result.value).toEqual({ event: 'keypress', data: 'a' })
		}

		controller!.close()
		await iter.return(undefined)
	})
})

describe('parseStream e2e', () => {
	test('tail -f a file, parse objects as they are appended', async () => {
		const { tailFile } = await import('./tail-file')
		const { appendFile } = await import('fs/promises')
		const path = '/tmp/hal-ason-e2e-test.ason'
		await Bun.write(path, '')

		const stream = tailFile(path)
		const iter = parseStream(stream)

		// Give tail -f a moment to start watching
		await Bun.sleep(100)


		async function nextValue(): Promise<any> {
			const { done, value } = await iter.next()
			if (done) throw new Error('stream ended unexpectedly')
			return value
		}

		await appendFile(path, "{ name: 'alice', score: 100 }\n")
		expect(await nextValue()).toEqual({ name: 'alice', score: 100 })

		await appendFile(path, "{ name: 'bob', score: 200 }\n")
		expect(await nextValue()).toEqual({ name: 'bob', score: 200 })

		// Partial line, then complete it
		await appendFile(path, "{ key: 'val")
		await Bun.sleep(50)
		await appendFile(path, "ue' }\n{ more: 42 }\n")
		expect(await nextValue()).toEqual({ key: 'value' })
		expect(await nextValue()).toEqual({ more: 42 })

		// Clean up
		await iter.return(undefined)
		;(await Bun.file(path).exists()) && (await Bun.$`rm ${path}`)
	}, 5000)
})


describe('comments', () => {
	describe('parse with comments', () => {
		test('block comment before object key', () => {
			const r = parse('{ /* greeting */ a: 1 }', { comments: true })
			expect(r.a).toBe(1)
			expect(r[COMMENTS]).toEqual({ a: '/* greeting */' })
		})

		test('line comment before object key', () => {
			const r = parse('{\n// hello\na: 1\n}', { comments: true })
			expect(r.a).toBe(1)
			expect(r[COMMENTS]).toEqual({ a: '// hello\n' })
		})

		test('multiple comments before key are concatenated', () => {
			const r = parse('{\n// first\n// second\na: 1\n}', { comments: true })
			expect(r.a).toBe(1)
			expect(r[COMMENTS]).toEqual({ a: '// first\n// second\n' })
		})

		test('comments on different keys', () => {
			const r = parse('{ /* a */ a: 1, /* b */ b: 2 }', { comments: true })
			expect(r.a).toBe(1)
			expect(r.b).toBe(2)
			expect(r[COMMENTS]).toEqual({ a: '/* a */', b: '/* b */' })
		})

		test('comment after value attaches to next key', () => {
			const r = parse('{ a: 1, // between\nb: 2 }', { comments: true })
			expect(r.a).toBe(1)
			expect(r.b).toBe(2)
			expect(r[COMMENTS]).toEqual({ b: '// between\n' })
		})

		test('no COMMENTS symbol without option', () => {
			const r = parse('{ /* greeting */ a: 1 }')
			expect(r[COMMENTS]).toBeUndefined()
		})

		test('no COMMENTS symbol when no comments present', () => {
			const r = parse('{ a: 1 }', { comments: true })
			expect(r[COMMENTS]).toBeUndefined()
		})

		test('array with comments — sparse array', () => {
			const r = parse('[/* first */ 1, 2, /* third */ 3]', { comments: true })
			expect([...r]).toEqual([1, 2, 3])
			const c = r[COMMENTS]
			expect(c[0]).toBe('/* first */')
			expect(c[1]).toBeUndefined()
			expect(c[2]).toBe('/* third */')
		})
	})

	describe('stringify with comments', () => {
		test('object with comments', () => {
			const obj = { a: 1, b: 2, [COMMENTS]: { a: '/* greeting */' } }
			expect(stringify(obj)).toBe('{\n  /* greeting */\n  a: 1,\n  b: 2\n}')
		})

		test('array with comments', () => {
			const arr = Object.assign([1, 2, 3], { [COMMENTS]: ['/* first */',,, ] })
			expect(stringify(arr)).toBe('[\n  /* first */\n  1,\n  2,\n  3\n]')
		})

		test('short mode skips comments', () => {
			const obj = { a: 1, [COMMENTS]: { a: '/* hi */' } }
			expect(stringify(obj, 'short')).toBe('{ a: 1 }')
		})

		test('multi-line comment indented correctly', () => {
			const obj = { a: { b: 1, [COMMENTS]: { b: '// inner\n' } } }
			expect(stringify(obj)).toBe('{\n  a: {\n    // inner\n    b: 1\n  }\n}')
		})
	})

	describe('roundtrip', () => {
		test('object comments survive roundtrip', () => {
			const src = '{\n  /* greeting */\n  a: 1,\n  b: 2\n}'
			const parsed = parse(src, { comments: true })
			expect(stringify(parsed)).toBe(src)
		})

		test('blank line before comment survives roundtrip', () => {
			const src = '{\n  a: 1,\n\n  // section two\n  b: 2\n}'
			const parsed = parse(src, { comments: true })
			expect(parsed[COMMENTS]).toEqual({ b: '\n// section two\n' })
			expect(stringify(parsed)).toBe(src)
		})

		test('no blank line before first comment', () => {
			const src = '{\n  // first key\n  a: 1,\n  b: 2\n}'
			const parsed = parse(src, { comments: true })
			expect(parsed[COMMENTS]).toEqual({ a: '// first key\n' })
			expect(stringify(parsed)).toBe(src)
		})
	})
})
