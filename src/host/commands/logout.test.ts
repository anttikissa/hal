// /logout removes exactly the accounts named by their /status ids and
// keeps every other login in the credentials file.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../../common/ason.ts'
import { auth } from '../auth.ts'
import { paths } from '../paths.ts'
import { command } from './logout.ts'

const savedHome = paths.state.home
const savedKey = process.env.OPENAI_API_KEY
let home = ''
const ctx: any = { sessionId: 's', cwd: '/', model: 'hal/intro', setCwd() {}, setModel() {}, say() {} }

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-logout-`)
	mkdirSync(`${home}/secrets`)
	paths.state.home = home
	process.env.OPENAI_API_KEY = 'env-key'
	writeFileSync(
		paths.authFile(),
		ason.stringify({
			anthropic: { accessToken: 'a1', email: 'a@example.com' },
			openai: [{ accessToken: 'o1' }, { accessToken: 'o2' }, { accessToken: 'o3' }, { apiKey: 'o4' }],
			serper: { apiKey: 's' },
		}),
	)
})

afterEach(() => {
	auth.close()
	paths.state.home = savedHome
	if (savedKey === undefined) delete process.env.OPENAI_API_KEY
	else process.env.OPENAI_API_KEY = savedKey
	rmSync(home, { recursive: true, force: true })
})

const disk = () => ason.parse(readFileSync(paths.authFile(), 'utf8')) as any

test('removes the named accounts across providers and keeps the rest', () => {
	expect(command.run('o2 o4 a1', undefined, ctx)).toEqual({
		say: 'logged out of a1 a@example.com, o2 account 2, o4 account 4',
	})
	expect(disk()).toEqual({ openai: [{ accessToken: 'o1' }, { accessToken: 'o3' }], serper: { apiKey: 's' } })
})

test('refuses unknown ids and environment keys, changing nothing', () => {
	let before = readFileSync(paths.authFile(), 'utf8')
	expect((command.run('o9', undefined, ctx) as any).error).toContain('o9: no such account')
	expect((command.run('o1 o5', undefined, ctx) as any).error).toBe('o5 comes from OPENAI_API_KEY; unset it')
	expect(readFileSync(paths.authFile(), 'utf8')).toBe(before)
})

test('without ids asks which; the answer removes that one', () => {
	let ask = (command.run('', undefined, ctx) as any).ask
	expect(ask.fields[0].options).toContain('o3 account 3')
	command.run('', { account: 'o3 account 3' }, ctx)
	expect(disk().openai).toHaveLength(3)
	expect(disk().openai.map((e: any) => e.accessToken ?? e.apiKey)).toEqual(['o1', 'o2', 'o4'])
})
