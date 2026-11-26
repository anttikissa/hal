import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { toolDetails } from '../../common/tool-details.ts'
import { transcript } from '../../common/transcript.ts'
import { history } from '../history.ts'
import { calls, client, created, testHome, until, useHost } from '../host-fixture.test.ts'
import { nativeTool } from '../native-tool.ts'
import { sessions } from '../sessions.ts'
import { tools } from '../tools.ts'
import { saveSecret } from './save_secret.ts'

useHost()

const results = (call: (typeof calls)[number]) =>
	call.input.messages.flatMap((m: any) => m.blocks).filter((b: any) => b.type === 'tool_result')

test('SAVE_SECRET prompts securely, creates 0600, preserves existing mode, warns on replace and never leaks', async () => {
	let work = join(testHome(), 'app')
	mkdirSync(work)
	let envFile = join(work, '.env.prod')
	let c = client()
	let id = created(c, work)

	// First call: missing file -> no replace warning; created with mode 0600.
	c.conn.send({ type: 'submit', sessionId: id, text: 'set key' })
	await until(() => calls.length === 1)
	calls[0]!.push(
		{
			type: 'tool_call',
			id: 's1',
			name: 'tool',
			input: { cmd: 'SAVE_SECRET /* Add Resend key */ { file: ".env.prod", name: "RESEND_API_KEY" }' },
		},
		{ type: 'done', reason: 'tool_use' },
	)
	await until(() => transcript.question(c.views.get(id)))
	let q1 = transcript.question(c.views.get(id))!
	expect(q1.form.text).toContain('Add Resend key')
	expect(q1.form.text).toContain('.env.prod')
	expect(q1.form.text).not.toContain('This replaces the current value.')
	expect(q1.form.fields).toEqual([{ type: 'secret', name: 'secret', label: 'RESEND_API_KEY' }])
	expect(q1.form.skip).toBe(true)

	let secret1 = 're_live_SUPER_SECRET_111'
	c.conn.send({ type: 'answer', sessionId: id, question: q1.id, answers: { secret: secret1 } })
	await until(() => calls.length === 2)

	expect(readFileSync(envFile, 'utf8')).toBe(`RESEND_API_KEY=${secret1}\n`)
	expect(statSync(envFile).mode & 0o777).toBe(0o600)
	expect(results(calls[1]!)).toEqual([expect.objectContaining({ id: 's1', output: 'saved' })])
	expect(results(calls[1]!)[0].isError).toBeUndefined()

	// Existing file with 0640 preserves its mode on update.
	writeFileSync(envFile, `# comment\nOTHER=1\nRESEND_API_KEY=${secret1}\nRESEND_API_KEY_2=keep\n`)
	chmodSync(envFile, 0o640)

	calls[1]!.push(
		{
			type: 'tool_call',
			id: 's2',
			name: 'tool',
			input: { cmd: 'SAVE_SECRET { file: ".env.prod", name: "RESEND_API_KEY" }' },
		},
		{ type: 'done', reason: 'tool_use' },
	)
	await until(() => transcript.question(c.views.get(id))?.id !== q1.id && transcript.question(c.views.get(id)))
	let q2 = transcript.question(c.views.get(id))!
	expect(q2.form.text).toContain('Save RESEND_API_KEY to')
	expect(q2.form.text).toContain('This replaces the current value.')

	let secret2 = 're_live_ROTATED_SECRET_222'
	c.conn.send({ type: 'answer', sessionId: id, question: q2.id, answers: { secret: secret2 } })
	await until(() => calls.length === 3)

	expect(readFileSync(envFile, 'utf8')).toBe(`# comment\nOTHER=1\nRESEND_API_KEY=${secret2}\nRESEND_API_KEY_2=keep\n`)
	expect(statSync(envFile).mode & 0o777).toBe(0o640)
	expect(results(calls[2]!).at(-1)).toMatchObject({ id: 's2', output: 'saved' })

	calls[2]!.push({ type: 'text', text: 'all set' }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length)

	let historyText = readFileSync(history.file(id), 'utf8')
	let eventsText = JSON.stringify(c.events)
	let providerText = JSON.stringify(calls.map((call) => call.input))
	for (let s of [secret1, secret2]) {
		expect(historyText).not.toContain(s)
		expect(eventsText).not.toContain(s)
		expect(providerText).not.toContain(s)
	}
	expect(c.of('answer')[0]).toMatchObject({ answers: {}, secrets: ['secret'] })
})

test('Escape, empty input and newline values never write and never leak; multi-call rounds save each key', async () => {
	let work = join(testHome(), 'multi')
	mkdirSync(work)
	let envFile = join(work, '.env')
	let c = client()
	let id = created(c, work)

	c.conn.send({ type: 'submit', sessionId: id, text: 'keys' })
	await until(() => calls.length === 1)
	calls[0]!.push(
		{
			type: 'tool_call',
			id: 'c1',
			name: 'tool',
			input: { cmd: 'SAVE_SECRET { file: ".env", name: "KEY_ESC" }' },
		},
		{
			type: 'tool_call',
			id: 'c2',
			name: 'tool',
			input: { cmd: 'SAVE_SECRET { file: ".env", name: "KEY_EMPTY" }' },
		},
		{
			type: 'tool_call',
			id: 'c3',
			name: 'tool',
			input: { cmd: 'SAVE_SECRET { file: ".env", name: "KEY_BAD" }' },
		},
		{
			type: 'tool_call',
			id: 'c4',
			name: 'tool',
			input: { cmd: 'SAVE_SECRET { file: ".env", name: "KEY_ONE" }' },
		},
		{
			type: 'tool_call',
			id: 'c5',
			name: 'tool',
			input: { cmd: 'SAVE_SECRET { file: ".env", name: "KEY_TWO" }' },
		},
		{ type: 'done', reason: 'tool_use' },
	)

	// c1: Escape -> canceled
	await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.label === 'KEY_ESC')
	c.conn.send({ type: 'pause', sessionId: id })

	// c2: empty submit -> canceled
	await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.label === 'KEY_EMPTY')
	let q2 = transcript.question(c.views.get(id))!
	c.conn.send({ type: 'answer', sessionId: id, question: q2.id, answers: { secret: '' } })

	// c3: value with newline -> error, nothing written, secret never leaked
	await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.label === 'KEY_BAD')
	let q3 = transcript.question(c.views.get(id))!
	let badSecret = 'secret_part_A\nINJECTED=1'
	c.conn.send({ type: 'answer', sessionId: id, question: q3.id, answers: { secret: badSecret } })

	// c4 and c5: two valid secrets in the same round
	await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.label === 'KEY_ONE')
	let q4 = transcript.question(c.views.get(id))!
	c.conn.send({ type: 'answer', sessionId: id, question: q4.id, answers: { secret: 'val_one_XYZ' } })

	await until(() => transcript.question(c.views.get(id))?.form.fields[0]?.label === 'KEY_TWO')
	let q5 = transcript.question(c.views.get(id))!
	c.conn.send({ type: 'answer', sessionId: id, question: q5.id, answers: { secret: 'val_two_XYZ' } })

	await until(() => calls.length === 2)
	let out = results(calls[1]!)
	expect(out.map((r: any) => [r.id, r.output, !!r.isError])).toEqual([
		['c1', 'canceled', false],
		['c2', 'canceled', false],
		['c3', expect.stringContaining('line break'), true],
		['c4', 'saved', false],
		['c5', 'saved', false],
	])
	expect(readFileSync(envFile, 'utf8')).toBe('KEY_ONE=val_one_XYZ\nKEY_TWO=val_two_XYZ\n')
	expect(statSync(envFile).mode & 0o777).toBe(0o600)

	calls[1]!.push({ type: 'text', text: 'done' }, { type: 'done', reason: 'end' })
	await until(() => c.of('turn-end').length)

	let leaked = [badSecret, 'secret_part_A', 'val_one_XYZ', 'val_two_XYZ']
	let allText = readFileSync(history.file(id), 'utf8') + JSON.stringify(c.events) + JSON.stringify(calls[1]!.input)
	for (let s of leaked) expect(allText).not.toContain(s)
})

test('writeEnv replaces or appends cleanly, preserves mode and CRLF, handles $ literals and rejects newlines', () => {
	let dir = join(testHome(), 'envtest')
	mkdirSync(dir)
	let file = join(dir, '.env')

	// Append to a file without a trailing newline and preserve existing permissions.
	writeFileSync(file, 'FIRST=1\n# SECOND=commented\nSECOND_EXTRA=keep')
	chmodSync(file, 0o644)
	saveSecret.writeEnv(file, 'SECOND', 'val # with spaces "raw"')
	expect(readFileSync(file, 'utf8')).toBe(
		'FIRST=1\n# SECOND=commented\nSECOND_EXTRA=keep\nSECOND=val # with spaces "raw"\n',
	)
	expect(statSync(file).mode & 0o777).toBe(0o644)

	// Replace and append on CRLF files, keeping $ sequences literal and allowing lowercase names.
	writeFileSync(file, 'A=1\r\nmy_key=old\r\nC=3\r\n')
	saveSecret.writeEnv(file, 'my_key', 'new$$1$&val')
	saveSecret.writeEnv(file, 'EXTRA', '2')
	expect(readFileSync(file, 'utf8')).toBe('A=1\r\nmy_key=new$$1$&val\r\nC=3\r\nEXTRA=2\r\n')

	// Reject CR/LF without changing the file.
	expect(() => saveSecret.writeEnv(file, 'my_key', 'bad\nline')).toThrow(/line break/)
	expect(() => saveSecret.writeEnv(file, 'my_key', 'bad\rline')).toThrow(/line break/)
	expect(readFileSync(file, 'utf8')).toBe('A=1\r\nmy_key=new$$1$&val\r\nC=3\r\nEXTRA=2\r\n')
})

test('invalid names and bad targets fail without prompting; non-interactive sessions lack SAVE_SECRET', async () => {
	let work = join(testHome(), 'bad')
	mkdirSync(work)
	mkdirSync(join(work, 'adir'))

	let c = client()
	let id = created(c, work)
	c.conn.send({ type: 'submit', sessionId: id, text: 'try bad' })
	await until(() => calls.length === 1)
	calls[0]!.push(
		{ type: 'tool_call', id: 'n1', name: 'tool', input: { cmd: 'SAVE_SECRET { file: ".env", name: "1A" }' } },
		{ type: 'tool_call', id: 'n2', name: 'tool', input: { cmd: 'SAVE_SECRET { file: ".env", name: "BAD=KEY" }' } },
		{ type: 'tool_call', id: 'd1', name: 'tool', input: { cmd: 'SAVE_SECRET { file: "missing/.env", name: "OK" }' } },
		{ type: 'tool_call', id: 'd2', name: 'tool', input: { cmd: 'SAVE_SECRET { file: "adir", name: "OK" }' } },
		{ type: 'tool_call', id: 'ok', name: 'tool', input: { cmd: 'SAVE_SECRET { file: ".env", name: "ok_key" }' } },
		{ type: 'done', reason: 'tool_use' },
	)

	await until(() => transcript.question(c.views.get(id)))
	let q = transcript.question(c.views.get(id))!
	expect(q.form.fields[0]?.label).toBe('ok_key')
	c.conn.send({ type: 'answer', sessionId: id, question: q.id, answers: { secret: 'good_val' } })
	await until(() => calls.length === 2)

	let out = results(calls[1]!)
	expect(out.slice(0, 4).every((r: any) => r.isError)).toBe(true)
	expect(out[0].output).toContain('[A-Za-z_][A-Za-z0-9_]*')
	expect(out[1].output).toContain('[A-Za-z_][A-Za-z0-9_]*')
	expect(out[2].output).toContain('directory does not exist')
	expect(out[3].output).toContain('file is a directory')
	expect(out[4]).toMatchObject({ id: 'ok', output: 'saved' })
	expect(readFileSync(join(work, '.env'), 'utf8')).toBe('ok_key=good_val\n')

	// Non-interactive sessions do not have SAVE_SECRET available.
	let sub = sessions.create({ cwd: work, interactive: false })
	expect(tools.allowed(id).some((t) => t.name === 'save_secret')).toBe(true)
	expect(tools.allowed(sub.id).some((t) => t.name === 'save_secret')).toBe(false)
	let blocked = await tools.run(
		{ type: 'tool_call', id: 'no', name: 'save_secret', input: { file: '.env', name: 'OK' } },
		{ sessionId: sub.id, cwd: work, signal: new AbortController().signal },
	)
	expect(blocked.isError).toBe(true)
	expect(blocked.output).toContain('SAVE_SECRET is not available')
})

test('HELP, Other tools line and card headlines describe SAVE_SECRET clearly', async () => {
	let c = client()
	let id = created(c)
	let helpRes = await tools.run(
		{ type: 'tool_call', id: 'h', name: 'help', input: { name: 'SAVE_SECRET' } },
		{ sessionId: id, cwd: testHome(), signal: new AbortController().signal },
	)
	expect(helpRes.output).toContain('## SAVE_SECRET')
	expect(helpRes.output).toContain('SAVE_SECRET /* <purpose> */ { file, name }')
	expect(helpRes.output).toContain('0600')

	let line =
		'\tSAVE_SECRET /* Add or update API_KEY in .env */ { file: ".env", name: "API_KEY" } // prompt user securely for the key; model never sees it'
	expect(nativeTool.guides(undefined, true, { session_interactive: 'true' })).toContain(line)
	expect(nativeTool.guides(undefined, true, { session_interactive: 'false' })).not.toContain(line)

	expect(
		toolDetails.headline('save_secret', {
			description: 'Add Resend API key to prod env',
			file: '/app/.env.prod',
			name: 'RESEND_API_KEY',
		}),
	).toEqual({ text: 'save_secret Add Resend API key to prod env', key: 'description', mark: 'save_secret' })

	expect(toolDetails.headline('save_secret', { file: '.env.prod', name: 'RESEND_API_KEY' })).toEqual({
		text: 'save_secret Save RESEND_API_KEY to .env.prod',
		keys: ['name', 'file'],
		mark: 'save_secret',
	})
})
