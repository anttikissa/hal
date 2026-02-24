import { describe, test, expect } from 'bun:test'
import { stringify, parse, parseAll, parseStream } from './ason'

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
		test('negative float', () => expect(parse('-3.14')).toBe(-3.14))
		test('NaN', () => expect(parse('NaN')).toBeNaN())
		test('Infinity', () => expect(parse('Infinity')).toBe(Infinity))
		test('-Infinity', () => expect(parse('-Infinity')).toBe(-Infinity))
		test('single-quoted string', () => expect(parse("'hello'")).toBe('hello'))
		test('double-quoted string', () => expect(parse('"hello"')).toBe('hello'))
		test('string with escapes', () => expect(parse("'a\\nb\\tc'")).toBe('a\nb\tc'))
		test('string with escaped quote', () => expect(parse("'it\\'s'")).toBe("it's"))
		test('double-quoted with single inside', () => expect(parse('"it\'s"')).toBe("it's"))
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
			expect(() => parse('tru')).toThrow(/Unexpected token/)
			expect(() => parse('tru')).toThrow(/tru/)
			expect(() => parse('tru')).toThrow(/\^/)
		})
		test('error points to right column', () => {
			try {
				parse('{ value: tru }')
				throw new Error('should have thrown')
			} catch (e: any) {
				expect(e.message).toContain('1:10')
				expect(e.message).toContain('value: tru }')
				expect(e.message).toMatch(/\n {13}\^/) // 4 padding + 9 col offset
			}
		})
		test('error on correct line and column', () => {
			try {
				parse('{\n  a: 1,\n  b: tru,\n}')
				throw new Error('should have thrown')
			} catch (e: any) {
				expect(e.message).toContain('3:6')
				expect(e.message).toContain('b: tru,')
			}
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

	test('throws on invalid token', async () => {
		expect(collect(toStream(['{ a: @@@ }\n']))).rejects.toThrow(/Unexpected token/)
	})

	test('yields valid values then throws on invalid token', async () => {
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
		const path = '/tmp/hal-ason-e2e-test.ason'
		await Bun.write(path, '')

		const tail = Bun.spawn(['tail', '-f', path], { stdout: 'pipe' })
		const iter = parseStream(tail.stdout as ReadableStream<Uint8Array>)

		async function nextValue(): Promise<any> {
			const { done, value } = await iter.next()
			if (done) throw new Error('stream ended unexpectedly')
			return value
		}

		await Bun.write(path, "{ name: 'alice', score: 100 }\n")
		expect(await nextValue()).toEqual({ name: 'alice', score: 100 })

		// Append second object
		const f = Bun.file(path)
		const prev = await f.text()
		await Bun.write(path, prev + "{ name: 'bob', score: 200 }\n")
		expect(await nextValue()).toEqual({ name: 'bob', score: 200 })

		// Append a partial line, then complete it
		const prev2 = await Bun.file(path).text()
		await Bun.write(path, prev2 + "{ key: 'val")
		await Bun.sleep(50)
		const prev3 = await Bun.file(path).text()
		await Bun.write(path, prev3 + "ue' }\n{ more: 42 }\n")
		expect(await nextValue()).toEqual({ key: 'value' })
		expect(await nextValue()).toEqual({ more: 42 })

		// Clean up
		tail.kill()
		;(await Bun.file(path).exists()) && (await Bun.$`rm ${path}`)
	}, 5000)
})
