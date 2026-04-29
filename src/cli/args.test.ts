import { expect, test } from 'bun:test'
import { cliArgs } from './args.ts'

test('parse defaults to the caller working directory', () => {
	const parsed = cliArgs.parse([], { cwd: '/work/project', halDir: '/hal' })

	expect(parsed).toEqual({ ok: true, help: false, targetCwd: '/work/project' })
})

test('parse supports --self for the Hal directory', () => {
	const parsed = cliArgs.parse(['--self'], { cwd: '/work/project', halDir: '/hal' })

	expect(parsed).toEqual({ ok: true, help: false, targetCwd: '/hal' })
})

test('parse accepts --fresh like -f', () => {
	const parsed = cliArgs.parse(['--fresh'], { cwd: '/work/project', halDir: '/hal' })

	expect(parsed).toEqual({ ok: true, help: false, targetCwd: '/work/project' })
})

test('parse supports --state-dir with a following path or equals form', () => {
	const env = { cwd: '/work/project', halDir: '/hal' }

	expect(cliArgs.parse(['--state-dir', '/tmp/hal-state-8XonO2'], env)).toEqual({
		ok: true,
		help: false,
		targetCwd: '/work/project',
		stateDir: '/tmp/hal-state-8XonO2',
	})
	expect(cliArgs.parse(['--state-dir=/tmp/hal-state-8XonO2'], env)).toEqual({
		ok: true,
		help: false,
		targetCwd: '/work/project',
		stateDir: '/tmp/hal-state-8XonO2',
	})
})

test('parse rejects unknown options and positional parameters', () => {
	expect(cliArgs.parse(['asdf'], { cwd: '/work/project', halDir: '/hal' })).toEqual({
		ok: false,
		error: 'Unexpected argument: asdf',
	})
	expect(cliArgs.parse(['--wat'], { cwd: '/work/project', halDir: '/hal' })).toEqual({
		ok: false,
		error: 'Unknown option: --wat',
	})
	expect(cliArgs.parse(['--state-dir'], { cwd: '/work/project', halDir: '/hal' })).toEqual({
		ok: false,
		error: '--state-dir requires a directory',
	})
})
