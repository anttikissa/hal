import { describe, test, expect } from 'bun:test'
import { stringify, parse, parseAll, parseStream, COMMENTS, type AsonObject, type AsonArray } from './ason'

describe('stringify', () => {
	describe('primitives', () => {
		test('bigint', () => expect(stringify(42n)).toBe('42n'))

		test('string with newline (smart)', () => expect(stringify('a\nb')).toBe('`a\nb`'))
	})

	describe('backtick multiline strings', () => {
		test('multiline string uses backticks in smart mode', () =>
			expect(stringify('line1\nline2\nline3')).toBe('`line1\nline2\nline3`'))

		test('escapes ${ in content', () => expect(stringify('cost: ${x}\ndone')).toBe('`cost: \\${x}\ndone`'))
	})

	describe('objects', () => {
		test('non-identifier key', () => expect(stringify({ '*': 123 })).toBe("{ '*': 123 }"))
	})
})

describe('stringify modes', () => {
	const wide = {
		name: 'alice',
		email: 'alice@example.com',
		score: 100,
		tags: ['admin', 'user', 'moderator'],
	}

	test('long always uses multi-line', () => {
		const result = stringify({ a: 1 }, 'long')
		expect(result).toContain('\n')
		expect(result).toBe('{\n\ta: 1\n}')
	})

	test('long visits each nested value once', () => {
		let reads = 0
		let value: unknown = 1
		for (let depth = 0; depth < 12; depth++) {
			const child = value
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
})

describe('parse', () => {
	describe('primitives', () => {
		test('float', () => expect(parse('3.14')).toBe(3.14))

		test('scientific notation', () => expect(parse('1e10')).toBe(1e10))

		// Numeric separators (underscores in numbers, like JS)
		test('integer with underscores', () => expect(parse('1_000_000')).toBe(1000000))

		// BigInt literals
		test('bigint integer', () => expect(parse('42n')).toBe(42n))

		test('string with escapes', () => expect(parse("'a\\nb\\tc'")).toBe('a\nb\tc'))

		test('string with hex escape', () => expect(parse("'\\x41'")).toBe('A'))

		test('string with unicode escape', () => expect(parse("'\\u0041'")).toBe('A'))

		test('invalid unicode escape: too short', () =>
			expect(() => parse("'\\u00'")).toThrow(/Invalid unicode escape/))
		test('invalid unicode escape: bad hex', () =>
			expect(() => parse("'\\uXXXX'")).toThrow(/Invalid unicode escape/))
		test('backtick string', () => expect(parse('`hello`')).toBe('hello'))

		test('backtick escaped ${', () => expect(parse('`cost: \\${x}`')).toBe('cost: ${x}'))
		test('backtick rejects unescaped ${', () => expect(() => parse('`${x}`')).toThrow(/interpolation/))
	})

	describe('objects', () => {
		test('unquoted keys', () => expect(parse('{ x: 123 }')).toEqual({ x: 123 }))

		test('trailing comma', () => expect(parse('{ a: 1, b: 2, }')).toEqual({ a: 1, b: 2 }))
	})

	describe('arrays', () => {
		test('mixed types', () => expect(parse("[1, null, 'hello']")).toEqual([1, null, 'hello']))
	})

	describe('comments', () => {
		test('block comment inline', () => expect(parse('{ a: /* the val */ 1 }')).toEqual({ a: 1 }))

		test('nested block comments do not nest', () => {
			// /* ... */ does not nest — first */ closes it
			expect(parse('/* a /* b */ 42')).toBe(42)
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
		test('double-quoted keys', () => expect(parse('{ "name": "hal" }')).toEqual({ name: 'hal' }))
	})

	describe('errors', () => {
		test('unexpected token', () => {
			expect(() => parse('tru')).toThrow(/Expected 'e', got 'EOF'/)
			expect(() => parse('tru')).toThrow(/tru/)
			expect(() => parse('tru')).toThrow(/\^/)
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
	})
})

describe('parseAll', () => {
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
		expect(await collect(toStream(['{ a: 1 }\n']))).toEqual([{ a: 1 }])
	})

	test('multiple lines', async () => {
		expect(await collect(toStream(['{ a: 1 }\n{ b: 2 }\n']))).toEqual([{ a: 1 }, { b: 2 }])
	})

	test('line split across chunks', async () => {
		expect(await collect(toStream(['{ a:', ' 1 }\n']))).toEqual([{ a: 1 }])
	})

	test('multiple chunks multiple values', async () => {
		expect(await collect(toStream(['{ a: 1 }\n{ b', ': 2 }\n{ c: 3 }\n']))).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
	})

	test('trailing value without newline', async () => {
		expect(await collect(toStream(['{ a: 1 }']))).toEqual([{ a: 1 }])
	})

	test('blank lines are skipped', async () => {
		expect(await collect(toStream(['{ a: 1 }\n\n\n{ b: 2 }\n']))).toEqual([{ a: 1 }, { b: 2 }])
	})

	test('invalid first line is silently skipped', async () => {
		expect(await collect(toStream(['{ a: @@@ }\n{ b: 2 }']))).toEqual([{ b: 2 }])
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

		const result = await Promise.race([iter.next(), Bun.sleep(50).then(() => ({ timeout: true }) as const)])

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
		const { tails } = await import('./tail-file')
		const { appendFile } = await import('fs/promises')
		const path = '/tmp/hal-ason-e2e-test.asonl'
		await Bun.write(path, '')

		const stream = tails.tailFile(path)
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
	}, 10000)
})

describe('comments', () => {
	describe('stringify with comments', () => {
		test('object with comments', () => {
			const obj = { a: 1, b: 2, [COMMENTS]: { a: '/* greeting */' } }
			expect(stringify(obj)).toBe('{\n\t/* greeting */\n\ta: 1,\n\tb: 2\n}')
		})
	})

	describe('roundtrip', () => {
		test('object comments survive roundtrip', () => {
			const src = '{\n\t/* greeting */\n\ta: 1,\n\tb: 2\n}'
			const parsed = parse(src, { comments: true })
			expect(stringify(parsed)).toBe(src)
		})
	})
})
