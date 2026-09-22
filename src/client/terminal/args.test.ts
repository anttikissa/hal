import { expect, test } from 'bun:test'
import { cliArgs } from './args.ts'

test('parse selects a remote host or reuses the remembered host', () => {
	const env = { cwd: '/work/project', halDir: '/hal' }
	expect(cliArgs.parse(['-r', 'hal.example'], env)).toEqual({
		ok: true,
		help: false,
		targetCwd: '/work/project',
		remoteHost: 'hal.example',
	})
	expect(cliArgs.parse(['-r'], env)).toEqual({ ok: true, help: false, targetCwd: '/work/project', remoteHost: null })
})

test('parse accepts the auth command', () => {
	expect(cliArgs.parse(['auth'], { cwd: '/work/project', halDir: '/hal' })).toEqual({
		ok: true,
		help: false,
		targetCwd: '/work/project',
		auth: true,
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
