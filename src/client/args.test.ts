import { expect, test } from 'bun:test'
import { args } from './args.ts'

test('unknown arguments are errors, never the terminal', () => {
	for (let bad of [
		['--auth'],
		['help', 'x'],
		['foo'],
		['-p'],
		['-p', 'a', 'b'],
		['-p', 'a', '-m'],
		['-p', 'a', '-d', 'x', '-d', 'y'],
		['-p', 'a', '-x'],
		['-r', 'a', 'b'],
		['auth', 'x'],
		['serve', 'x'],
		['serve', '--port'],
		['serve', '--port', '0'],
		['serve', '--port', '9001', 'x'],
	])
		expect(args.parse(bad).kind).toBe('error')
})

test('known forms parse, print options in any order', () => {
	expect(args.parse([])).toEqual({ kind: 'terminal' })
	for (let h of ['-h', '--help', 'help']) expect(args.parse([h])).toEqual({ kind: 'help' })
	for (let v of ['-v', '--version']) expect(args.parse([v])).toEqual({ kind: 'version' })
	expect(args.parse(['auth'])).toEqual({ kind: 'auth' })
	expect(args.parse(['serve'])).toEqual({ kind: 'serve' })
	expect(args.parse(['serve', '--port', '9001'])).toEqual({ kind: 'serve', port: 9001 })
	expect(args.parse(['-r'])).toEqual({ kind: 'remote' })
	expect(args.parse(['-r', 'example.com'])).toEqual({ kind: 'remote', host: 'example.com' })
	expect(args.parse(['-p', 'Tee raportti', '-d', '~/x', '-m', 'opus-5.5'])).toEqual({
		kind: 'print',
		prompt: 'Tee raportti',
		dir: '~/x',
		model: 'opus-5.5',
	})
	expect(args.parse(['-m', 'gpt', 'hi', '--print'])).toEqual({ kind: 'print', prompt: 'hi', model: 'gpt' })
})

test('print target and delivery flags validate combinations', () => {
	expect(args.parse(['-p', 'answer', '--session', '07-bah', '--soft-steer'])).toEqual({
		kind: 'print',
		prompt: 'answer',
		session: '07-bah',
		delivery: 'soft-steer',
	})
	expect(args.parse(['-p', 'answer', '-s', '12', '--queue'])).toEqual({
		kind: 'print',
		prompt: 'answer',
		session: '12',
		delivery: 'queue',
	})
	expect(args.parse(['-p', 'answer', '--keep'])).toEqual({ kind: 'print', prompt: 'answer', keep: true })
	expect(args.parse(['-p', 'answer', '--no-user', '--session', '12'])).toEqual({
		kind: 'print',
		prompt: 'answer',
		session: '12',
		noUser: true,
	})
	expect(args.parse(['--no-user'])).toEqual({ kind: 'terminal', noUser: true })
	expect(args.parse(['serve', '--no-user'])).toEqual({ kind: 'serve', noUser: true })
	expect(args.parse(['--home', '/h', '--no-user'])).toEqual({ kind: 'terminal', noUser: true, home: '/h' })
	expect(args.parse(['-r', 'x', '--home', '/h'])).toEqual({ kind: 'remote', host: 'x', home: '/h' })
	for (let bad of [['--home'], ['--home', '-p', 'x'], ['--home', '/a', '--home', '/b']])
		expect(args.parse(bad).kind).toBe('error')
	for (let bad of [
		['-r', '--no-user'],
		['auth', '--no-user'],
		['--no-user', '--no-user'],
	])
		expect(args.parse(bad).kind).toBe('error')
	for (let flags of [
		['--session'],
		['--session', '12', '--keep'],
		['--steer', '--queue'],
		['--session', '12', '-d', '/tmp'],
	])
		expect(args.parse(['-p', 'answer', ...flags]).kind).toBe('error')
})

test('declarations reject duplicate aliases, missing values and wrong modes', () => {
	for (let bad of [
		['-p', 'hi', '-d', 'a', '--dir', 'b'],
		['-p', 'hi', '-s', '1', '--session', '2'],
		['-p', 'hi', '--print'],
		['-p', 'hi', '--help'],
		['--home', ''],
		['--home', '--help'],
		['-p', 'hi', '--model', '--keep'],
		['-p', 'hi', '--model', ''],
		['serve', '--port', '--no-user', '9001'],
		['-p', 'hi', '-m', '--home', '/h', 'opus'],
		['-p', 'hi', '--port', '9001'],
		['serve', '--keep'],
		['auth', '--model', 'opus'],
		['--dir', 'a'],
		['-r', '-'],
		['serve', '--port', '1.5'],
		['serve', '--port', '65536'],
		['serve', '--port', 'no'],
	])
		expect(args.parse(bad).kind).toBe('error')
})

test('command names remain values and parsing does not mutate argv or retain state', () => {
	let argv = ['--home', '/h', '--model', 'help', 'serve', '--print']
	let before = [...argv]
	expect(args.parse(argv)).toEqual({ kind: 'print', prompt: 'serve', model: 'help', home: '/h' })
	expect(argv).toEqual(before)
	expect(args.parse(['-p', 'auth'])).toEqual({ kind: 'print', prompt: 'auth' })
	expect(args.parse(['-r', 'help'])).toEqual({ kind: 'remote', host: 'help' })
	expect(args.parse(['serve', '--port', '65535'])).toEqual({ kind: 'serve', port: 65535 })
	expect(args.parse([])).toEqual({ kind: 'terminal' })
})
