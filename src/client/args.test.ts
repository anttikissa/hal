import { expect, test } from 'bun:test'
import { args } from './args.ts'

test('unknown arguments are errors, never the terminal', () => {
	for (let bad of [['--auth'], ['help', 'x'], ['foo'], ['-p'], ['-p', 'a', 'b'], ['-p', 'a', '-m'], ['-p', 'a', '-d', 'x', '-d', 'y'], ['-p', 'a', '-x'], ['-r', 'a', 'b'], ['auth', 'x'], ['serve', 'x']])
		expect(args.parse(bad).kind).toBe('error')
})

test('known forms parse, print options in any order', () => {
	expect(args.parse([])).toEqual({ kind: 'terminal' })
	for (let h of ['-h', '--help', 'help']) expect(args.parse([h])).toEqual({ kind: 'help' })
	for (let v of ['-v', '--version']) expect(args.parse([v])).toEqual({ kind: 'version' })
	expect(args.parse(['auth'])).toEqual({ kind: 'auth' })
	expect(args.parse(['serve'])).toEqual({ kind: 'serve' })
	expect(args.parse(['-r'])).toEqual({ kind: 'remote' })
	expect(args.parse(['-r', 'example.com'])).toEqual({ kind: 'remote', host: 'example.com' })
	expect(args.parse(['-p', 'Tee raportti', '-d', '~/x', '-m', 'opus-5.5'])).toEqual({ kind: 'print', prompt: 'Tee raportti', dir: '~/x', model: 'opus-5.5' })
	expect(args.parse(['-m', 'gpt', 'hi', '--print'])).toEqual({ kind: 'print', prompt: 'hi', model: 'gpt' })
})

test('print target and delivery flags validate combinations', () => {
	expect(args.parse(['-p', 'answer', '--session', '07-bah', '--soft-steer'])).toEqual({ kind: 'print', prompt: 'answer', session: '07-bah', delivery: 'soft-steer' })
	expect(args.parse(['-p', 'answer', '-s', '12', '--queue'])).toEqual({ kind: 'print', prompt: 'answer', session: '12', delivery: 'queue' })
	expect(args.parse(['-p', 'answer', '--keep'])).toEqual({ kind: 'print', prompt: 'answer', keep: true })
	expect(args.parse(['-p', 'answer', '--no-user'])).toEqual({ kind: 'print', prompt: 'answer', noUser: true })
	for (let flags of [['--session'], ['--session', '12', '--keep'], ['--session', '12', '--no-user'], ['--steer', '--queue'], ['--session', '12', '-d', '/tmp']])
		expect(args.parse(['-p', 'answer', ...flags]).kind).toBe('error')
})
