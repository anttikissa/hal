// First-class agy accounts: auth.ason references, /login agy, /logout,
// /status, /account, stats.plan, intro wizard, clean 429 errors, and
// ACP-log error extraction + rotation on Verification Required (task xbp).

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { agy } from './agy.ts'
import { agyAccounts } from './agy-accounts.ts'
import { agyLog } from './agy-log.ts'
import { agyQuota } from './agy-quota.ts'
import { auth } from './auth.ts'
import { clock } from './clock.ts'
import { command as accountCmd } from './commands/account.ts'
import { command as loginCmd } from './commands/login.ts'
import { command as logoutCmd } from './commands/logout.ts'
import { intro } from './intro.ts'
import { introAccounts } from './intro-accounts.ts'
import { limits } from './limits.ts'
import { loginAgy } from './login-agy.ts'
import { paths } from './paths.ts'
import { profile } from './profile.ts'
import { provider } from './provider.ts'
import { sessions } from './sessions.ts'
import { stats } from './stats.ts'
import { statusUsage } from './status-usage.ts'
import { provider as agyProvider } from './providers/agy.ts'
import { turnPolicy } from './turn-policy.ts'

const savedHome = paths.state.home
const origNow = clock.now
const origCmd = agy.command
const origQuotaFetch = agyQuota.fetch
const origAvail = loginAgy.available
const origProviders = { ...provider.state.providers }
const origProfile = profile.text
let home = ''
let now = 1_800_000_000_000

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-agy-acct-`)
	mkdirSync(`${home}/secrets`, { mode: 0o700 })
	paths.state.home = home
	paths.init()
	now = 1_800_000_000_000
	clock.now = () => now
	agyAccounts.state.chosen.clear()
	agyAccounts.state.picked.clear()
})

afterEach(() => {
	agy.stopAll()
	loginAgy.cancel()
	auth.close()
	limits.close()
	sessions.closeAll()
	agy.command = origCmd
	agyQuota.fetch = origQuotaFetch
	loginAgy.available = origAvail
	provider.state.providers = { ...origProviders }
	profile.text = origProfile
	clock.now = origNow
	agyAccounts.state.chosen.clear()
	agyAccounts.state.picked.clear()
	paths.state.home = savedHome
	rmSync(home, { recursive: true, force: true })
})

const writeAuth = (data: unknown) => writeFileSync(paths.authFile(), ason.stringify(data) + '\n', { mode: 0o600 })
const readAuth = () => ason.parse(readFileSync(paths.authFile(), 'utf8')) as any
const ctx: any = { sessionId: 's1', cwd: '/tmp', model: 'agy/gemini-4-neon', setCwd() {}, setModel() {}, say() {} }

test('auth.ason agy entries drive listing, slots, stats.plan, /account, /status and /logout', async () => {
	expect(agyAccounts.list()).toEqual([])
	expect(() => agyAccounts.pick('gemini-4-neon', 's1')).toThrow('no agy login; run /login agy')

	writeAuth({
		agy: [
			{ email: 'first@example.com', keychain: true },
			{ email: 'second@example.com', geminiDir: 'state/agy/second/gemini' },
		],
	})
	let list = agyAccounts.list()
	expect(list.map((a) => [a.name, a.keychain, a.geminiDir])).toEqual([
		['first@example.com', true, undefined],
		['second@example.com', undefined, `${home}/state/agy/second/gemini`],
	])
	expect(stats.plan('s1', 'agy/gemini-4-neon')).toMatchObject({ account: 'y1', accounts: 2 })

	expect(accountCmd.complete?.('', ctx)).toEqual([
		{ value: 'y1', description: 'first@example.com' },
		{ value: 'y2', description: 'second@example.com' },
	])
	expect(accountCmd.run('y2', undefined, ctx)).toEqual({
		say: 'this session uses agy account y2 second@example.com from its next request',
	})
	expect(stats.plan('s1', 'agy/gemini-4-neon')).toMatchObject({ account: 'y2', accounts: 2 })

	agyQuota.fetch = async (account) =>
		account.name === 'first@example.com'
			? { '5h': { used: 10, resets: new Date(now + 3600_000).toISOString() }, '7d': { used: 2 } }
			: { '5h': { used: 0 }, '7d': { used: 0 } }
	limits.set(limits.key('agy', 'first@example.com'), now + 3600_000)
	agyAccounts.needsVerification(
		'second@example.com',
		'Verify your account to continue.',
		'https://accounts.google.com/v3/verify',
	)
	let shown = await statusUsage.show('s1', 'agy/gemini-4-neon')
	expect(shown).toContain('Antigravity accounts:')
	expect(shown).toContain('| Slot | Account | 5h | 7d | Status |')
	expect(shown).toContain('| y1 | first@example.com |')
	expect(shown).toContain('10% used')
	expect(shown).toContain('| limited until')
	expect(shown).toContain('| y2 * | second@example.com |')
	expect(shown).toContain('| Verification required')
	expect(shown).toContain('https://accounts.google.com/v3/verify')

	expect(logoutCmd.run('y2', undefined, ctx)).toEqual({ say: 'logged out of y2 second@example.com' })
	expect(readAuth().agy).toEqual([{ email: 'first@example.com', keychain: true }])
})

test('/login agy runs agy --login with SSH_CONNECTION and --gemini-dir, saves reference, never echoes code', async () => {
	let fakeAgy = `${home}/fake-agy.ts`
	writeFileSync(
		fakeAgy,
		`let dir = process.argv[process.argv.indexOf('--gemini-dir') + 1] ?? ''
if (!process.env.SSH_CONNECTION || !dir) { console.error('missing env/dir'); process.exit(2) }
process.stdout.write('Open this link in a browser to log in with Google:\\n\\n  https://accounts.google.com/o/oauth2/auth?state=abc\\n\\nThen paste the code:\\n')
let text = await new Response(Bun.stdin.stream()).text()
if (text.trim() === 'good-secret-code') {
	process.stdout.write('Logged in as newuser@example.com.\\n')
	process.exit(0)
}
process.stderr.write('invalid code: ' + text.trim() + '\\n')
process.exit(1)
`,
	)
	agy.command = () => [process.execPath, fakeAgy]
	loginAgy.available = () => true

	let picker = await loginCmd.run('', undefined, ctx)
	expect(picker.ask?.fields[0]).toMatchObject({
		type: 'choice',
		options: expect.arrayContaining(['Antigravity (agy)']),
	})
	expect(loginCmd.complete?.('a', ctx)).toContain('agy')

	// Failure must not echo the pasted secret code or create auth.ason.
	let askBad = await loginCmd.run('agy', undefined, ctx)
	expect(askBad.ask?.text).toContain('https://accounts.google.com/o/oauth2/auth?state=abc')
	expect(askBad.ask?.fields[0]).toMatchObject({ type: 'secret', name: 'code' })
	let err = await (loginCmd.run(askBad.askArgs!, { code: 'bad-secret-code' }, ctx) as Promise<any>).catch((e) => e)
	expect(err).toBeInstanceOf(Error)
	expect(err.message).not.toContain('bad-secret-code')
	expect(existsSync(paths.authFile())).toBe(false)

	// Success records only { email, geminiDir } in secrets/auth.ason.
	let askOk = await loginCmd.run('', { method: 'Antigravity (agy)' }, ctx)
	expect(askOk.askArgs).toStartWith('agy ')
	let done = await loginCmd.run(askOk.askArgs!, { code: 'good-secret-code' }, ctx)
	expect(done).toEqual({ say: 'logged in to agy as newuser@example.com' })
	let stored = readAuth().agy
	expect(stored.email).toBe('newuser@example.com')
	expect(stored.geminiDir).toMatch(/^state\/agy\/[a-z0-9-]+\/gemini$/)
	expect(stored.accessToken).toBeUndefined()
})

test('ACP log parser extracts Google 403 VALIDATION_REQUIRED details and verify URL, and agy rotates without hiding errors', async () => {
	let sampleLog = `I1124 16:35:45.826912 29 server_oauth.go:226] OAuth: authenticated successfully as lex.michaelis@gmail.com
I1124 16:35:47.488813 204 http_helpers.go:987] Failed to make code assist backend request (https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary): {
  "error": {
    "code": 403,
    "message": "Verify your account to continue.",
    "status": "PERMISSION_DENIED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "VALIDATION_REQUIRED",
        "domain": "cloudcode-pa.googleapis.com",
        "metadata": {
          "validation_error_message": "Verify your account to continue.",
          "validation_url": "https://accounts.google.com/v3/signin/continue?plt=TOKEN123",
          "validation_learn_more_url": "https://support.google.com/accounts?p=al_alert"
        }
      }
    ]
  }
}
E1124 16:35:48.133288 409 errorreport.go:282] agent executor error: generating and executing: transport error (PermissionDenied, HTTP 403): Verify your account to continue.`

	expect(agyLog.email(sampleLog)).toBe('lex.michaelis@gmail.com')
	let parsed = agyLog.parseFailure(sampleLog)!
	expect(parsed.code).toBe(403)
	expect(parsed.reason).toBe('VALIDATION_REQUIRED')
	expect(parsed.url).toBe('https://accounts.google.com/v3/signin/continue?plt=TOKEN123')
	expect(parsed.detail).toContain('HTTP 403 PERMISSION_DENIED VALIDATION_REQUIRED')
	expect(parsed.detail).toContain('Verify your account to continue.')
	expect(parsed.detail).toContain('https://accounts.google.com/v3/signin/continue?plt=TOKEN123')
	expect(parsed.detail).toContain('https://support.google.com/accounts?p=al_alert')

	// Full stream test: account 1 hits Verification Required (with ACP log),
	// sets account 1 aside and asks to rotate; next pick selects account 2;
	// account 2 hits quota -> clean 429 without raw {"resets_in_seconds":...} body.
	let dir1 = `${home}/state/agy/one/gemini`
	let dir2 = `${home}/state/agy/two/gemini`
	mkdirSync(`${dir1}/antigravity-cli/log`, { recursive: true })
	mkdirSync(`${dir2}/antigravity-cli/log`, { recursive: true })
	writeAuth({
		agy: [
			{ email: 'one@example.com', geminiDir: dir1 },
			{ email: 'two@example.com', geminiDir: dir2 },
		],
	})
	let fakeAgy = `${home}/fake-acp.ts`
	writeFileSync(
		fakeAgy,
		`import { appendFileSync, mkdirSync } from 'fs'
let dir = process.argv[process.argv.indexOf('--gemini-dir') + 1] ?? ''
let logPath = dir + '/antigravity-cli/log/acp-server-20261124_163545-' + process.pid + '.log'
mkdirSync(dir + '/antigravity-cli/log', { recursive: true })
const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
const dec = new TextDecoder()
let buf = ''
for await (let chunk of Bun.stdin.stream()) {
	buf += dec.decode(chunk, { stream: true })
	let lines = buf.split('\\n')
	buf = lines.pop()!
	for (let line of lines) {
		if (!line.trim()) continue
		let m = JSON.parse(line)
		if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1 } })
		else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'acp-1', models: { currentModelId: 'gemini-4-neon-high', availableModels: [] } } })
		else if (m.method === 'session/set_model') send({ id: m.id, result: {} })
		else if (m.method === 'session/prompt') {
			let text = (m.params.prompt ?? []).map((p: any) => p.text ?? '').join('\\n')
			if (dir.endsWith('/one/gemini') && !text.includes('verified-now')) {
				appendFileSync(logPath, ${JSON.stringify(sampleLog)} + '\\n')
				send({ method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\\n⚠ Verification Required\\n' } } } })
				send({ id: m.id, result: { stopReason: 'end_turn' } })
			} else if (text.includes('trigger-quota')) {
				send({ method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'working' } } } })
				send({ method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\\n⚠ Individual quota reached. Resets in 1h2m3s.\\n' } } } })
				send({ id: m.id, result: { stopReason: 'end_turn' } })
			} else {
				send({ method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello from ' + (dir.endsWith('/one/gemini') ? 'one' : 'two') } } } })
				send({ id: m.id, result: { stopReason: 'end_turn' } })
			}
		}
	}
}
`,
	)
	agy.command = () => [process.execPath, fakeAgy]
	provider.register('agy', agyProvider)
	let s = sessions.create({ cwd: home, model: 'agy/gemini-4-neon' })

	let collect = async (text = 'hi') => {
		let events = []
		for await (let e of provider.stream('agy/gemini-4-neon', {
			sessionId: s.id,
			messages: [{ role: 'user', blocks: [{ type: 'text', text }] }],
		}))
			events.push(e)
		return events
	}

	// Attempt 1: account one needs verification -> error with full link + rotates.
	let e1 = await collect()
	expect(e1).toHaveLength(1)
	expect(e1[0]).toMatchObject({ type: 'error', status: 403, failure: 'auth', retryAt: now })
	expect((e1[0] as any).message).toContain('https://accounts.google.com/v3/signin/continue?plt=TOKEN123')
	expect(turnPolicy.mayRetry('agy', e1[0] as any)).toBe(true)
	expect(agyAccounts.verifyOf('one@example.com')?.url).toBe(
		'https://accounts.google.com/v3/signin/continue?plt=TOKEN123',
	)

	// Attempt 2: rotates to account two and succeeds.
	let e2 = await collect()
	expect(e2).toEqual([
		{ type: 'text', text: 'hello from two' },
		{ type: 'done', reason: 'end' },
	])

	// Quota after earlier output in the turn (55-bib): clean 429, no raw resets_in_seconds JSON body, sets limit.
	let e3 = await collect('trigger-quota')
	expect(e3).toHaveLength(2)
	expect(e3[0]).toEqual({ type: 'thinking', text: 'working' })
	expect(e3[1]).toMatchObject({ type: 'error', status: 429, failure: 'limited', retryAt: now })
	expect((e3[1] as any).body).toBeUndefined()
	expect((e3[1] as any).message).toContain('Individual quota reached. Resets in 1h2m3s.')
	expect(limits.on('agy/gemini-4-neon', 'two@example.com')).toBe(now + (3600 + 120 + 3) * 1000)

	// Explicitly picking account one after verifying in browser succeeds and clears the hold.
	agyAccounts.state.picked.set(s.id, 'one@example.com')
	let e4 = await collect('verified-now')
	expect(e4).toEqual([
		{ type: 'text', text: 'hello from one' },
		{ type: 'done', reason: 'end' },
	])
	expect(agyAccounts.verifyOf('one@example.com')).toBeUndefined()

	// If account one is the only account and hits Verification Required, turn ends in error (no retry loop).
	writeAuth({ agy: { email: 'one@example.com', geminiDir: dir1 } })
	auth.close()
	let e5 = await collect('still-unverified')
	expect(e5).toHaveLength(1)
	expect(e5[0]).toMatchObject({ type: 'error', status: 403 })
	expect((e5[0] as any).failure).toBeUndefined()
	expect((e5[0] as any).message).toContain('https://accounts.google.com/v3/signin/continue?plt=TOKEN123')
})

test('intro offers /login agy only when agy is available and recognizes stored agy accounts', () => {
	profile.text = () => ''
	let ts = new Date().toISOString()
	let afterName: any[] = [
		{
			type: 'assistant',
			block: { type: 'text', text: 'Hello — I am HAL 9001, the no-bloat agent harness. You can call me Hal.' },
			ts,
			n: 1,
		},
		{
			type: 'question',
			id: 'q1',
			form: { text: 'What should I call you?', fields: [{ type: 'text', name: 'name' }] },
			ts,
			n: 2,
		},
		{ type: 'answer', question: 'q1', answers: { name: 'Dave' }, ts, n: 3 },
	]
	provider.state.providers.agy = { ...agyProvider, available: () => false }
	let withoutAgy = intro.run(afterName)
	expect((withoutAgy.ask?.fields[0] as any)?.options).not.toContain('/login agy')
	expect(withoutAgy.say).not.toContain('Antigravity')

	provider.state.providers.agy = { ...agyProvider, available: () => true }
	let withAgy = intro.run(afterName)
	expect((withAgy.ask?.fields[0] as any)?.options).toContain('/login agy')
	expect(withAgy.say).toContain('Antigravity (agy)')

	writeAuth({ agy: { email: 'user@example.com', keychain: true } })
	expect(introAccounts.accounts()).toMatchObject({
		names: ['Antigravity (user@example.com)'],
		providers: ['agy'],
		stored: 1,
	})
})
