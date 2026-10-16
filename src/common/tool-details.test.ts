import { expect, test } from 'bun:test'
import { toolDetails } from './tool-details.ts'

test('bash reads like the terminal; odd arguments show once, plumbing never', () => {
	let input = { command: 'cat <<EOF\nhi\nEOF', description: 'Say hi', modifies: ['a.ts', 'src/*.ts'], background: true, timeout: 600, extra: 'x' }
	expect(toolDetails.lines('bash', input)).toEqual(['cat <<EOF', 'hi', 'EOF', 'Edits a.ts, src/*.ts', 'extra: x'])
	expect(toolDetails.lines('bash', { command: 'ls', description: 'List', timeout: 5, background: 'yes' })).toEqual(['ls', 'background: yes'])
	expect(toolDetails.limit('bash', { command: 'ls', timeout: 900 })).toBe('900s')
	expect(toolDetails.limit('bash', { command: 'ls', timeout: 600, background: true })).toBeUndefined()
	expect(toolDetails.headline('notify', { text: 'Done' })).toEqual({ text: '! Done', key: 'text', mark: '!' })
	expect(toolDetails.lines('notify', { text: 'Done' })).toEqual([])
})

test('rejected tool calls recover display-only purpose and task names without hiding raw input', () => {
	let malformed = { cmd: 'BASH /* Diagnose tool failures */ "rg "unreadable" fixture.ts"' }
	expect(toolDetails.headline('tool', malformed)).toMatchObject({ text: '$ Diagnose tool failures', mark: '$' })
	expect(toolDetails.lines('tool', malformed).join('\n')).toContain(malformed.cmd)
	let spawn = { cmd: 'SPAWN [{ name: "Clean oversized histories", task: "Work" }]' }
	expect(toolDetails.headline('tool', spawn).text).toBe('Spawn Clean oversized histories (autoclose ↧)')
	expect(toolDetails.lines('tool', spawn).join('\n')).toContain(spawn.cmd)
	expect(toolDetails.headline('tool', { cmd: 'SPAWN [{ name:' }).text).toBe('Spawn Subagent (autoclose ↧)')
	expect(toolDetails.headline('tool', { cmd: {} }).text).toBe('Tool')
})

test('inspect heads with every argument once; unknown ones still show', () => {
	expect(toolDetails.headline('inspect', { scope: 'self', fields: 'id,model,context' }).text).toBe('? Inspect self (id, model, context)')
	expect(toolDetails.headline('inspect', { what: 'host' }).text).toBe('? Inspect host')
	expect(toolDetails.lines('inspect', { scope: 'all', fields: 'tab', extra: 1 })).toEqual(['extra: 1'])
})

test('spawn and wait name the sessions their result reports', () => {
	let h = (name: string, input: Record<string, unknown>, out?: string) => toolDetails.headline(name, input, out).text
	expect(h('spawn', { name: 'v3 UI craft pass', task: 't' }, 'Started tab 3 · 31-swe · v3 UI craft pass. Its last message comes back here')).toBe('Spawn 31-swe (tab 3): v3 UI craft pass (autoclose ↧)')
	expect(h('spawn', { kind: 'interactive' }, 'Opened tab 4 · 31-sit for the user.')).toBe('Spawn 31-sit (tab 4) (interactive)')
	expect(h('wait', {}, 'Waiting for tab 3 · 31-swe · Pass, one, tab 5 · 31-bux. This turn ends here')).toBe('… Waiting for 31-swe, 31-bux')
	expect(h('bash', { command: 'serve', description: 'Start server', background: true })).toBe('$ Start server')
})

test('send headers distinguish requested destinations from host-resolved ones', () => {
	let input = { to: '2', description: 'Report completion', text: 'Done', queue: true }
	expect(toolDetails.headline('send', input).text).toBe('To tab 2: Report completion')
	expect(toolDetails.headline('send', input, 'Sent to tab 2 · 157-cms · Review').text).toBe('To 157-cms (tab 2): Report completion')
	expect(toolDetails.headline('send', { ...input, to: '157-cms' }, 'no session 157-cms').text).toBe('To 157-cms: Report completion')
	expect(toolDetails.headline('send', input, 'Sent to 157-cms · Review').text).toBe('To 157-cms: Report completion')
	expect(toolDetails.lines('send', input)).toEqual(['Done', 'queue: true'])
	for (let outcome of ['Sent to', 'Queued in', 'Waiting in', 'Interrupted']) {
		let output = `${outcome} tab 2 · 157-cms · Review: it reads this before its next request`
		expect(toolDetails.headline('send', input, output).text).toBe('To 157-cms (tab 2): Report completion')
	}
})

test('SEND without a description previews the first nonempty line and keeps the full expanded message', () => {
	let input = { to: '176-ict', text: '\nIndex available.\nPlease commit now.' }
	expect(toolDetails.headline('send', input).text).toBe('To 176-ict: Index available.')
	expect(toolDetails.lines('send', input)).toEqual(['', 'Index available.', 'Please commit now.'])
})

test('SEND exposes slash commands before destinations even with a purpose', () => {
	let input = { to: '2', text: '/close', description: 'Finish session' }
	expect(toolDetails.headline('send', input).text).toBe('To tab 2 /close: Finish session')
	expect(toolDetails.lines('send', input)).toEqual([])
	let multiline = { ...input, text: '/close\nnot discarded' }
	expect(toolDetails.lines('send', multiline)).toEqual(['/close', 'not discarded'])
})

test('command labels remain literal for discovery, sparse plans and other commands', () => {
	for (let command of ['/help', '/help rebase', '/rebase run --paused drop t4-; edit #u2 "new; edit is text"', '/rebase preview edit #2 `full\\nreplacement`', '/rename Keep slash labels']) {
		expect(toolDetails.headline('command', { command }).text).toBe(command)
		expect(toolDetails.lines('command', { command })).toEqual([])
	}
})

test('stored-output reads are distinguishable from file reads without repeating their reference', () => {
	let input = { id: '10-zap#1969', offset: 2, limit: 10 }
	expect(toolDetails.headline('read_blob', input).text).toBe('< 10-zap#1969')
	expect(toolDetails.lines('read_blob', input)).toEqual(['offset: 2', 'limit: 10'])
	expect(toolDetails.headline('read', { path: 'example.txt' }).text).toBe('< example.txt')
})

test('multi-file reads retain every range and unknown argument under its file', () => {
	let input = { paths: [{ path: 'first.ts', offset: 10, limit: 5 }, { path: 'second.ts', offset: 30, extra: 'keep me' }] }
	expect(toolDetails.headline('read', input).text).toBe('< first.ts, second.ts')
	expect(toolDetails.lines('read', input)).toEqual(['< first.ts', 'offset: 10', 'limit: 5', '< second.ts', 'offset: 30', 'extra: keep me'])
	expect(toolDetails.lines('read', { paths: [null] }).join('\n')).toContain('(null)')
})

test('wait headers follow background-work result contracts and preserve invalid targets', () => {
	expect(toolDetails.headline('wait', {}).text).toBe('… Waiting for background work')
	expect(toolDetails.headline('wait', {}, 'Work needs attention: t72, 12-xyz. Inspect the targets; available reports follow through their usual delivery.').text).toBe('… Waiting for t72, 12-xyz')
	expect(toolDetails.headline('wait', {}, 'No owned background command or subagent is running. Go on without waiting.').text).toBe('… Waiting (no background work running)')
	expect(toolDetails.lines('wait', { targets: ['#t72', 123] })).toEqual([])
	for (let name of ['wait', 'inspect', 'stop']) {
		let input = name === 'wait' ? { targets: [{ nested: 'bad' }] } : { target: { nested: 'bad' } }
		expect(toolDetails.headline(name, input).text).not.toContain('[object Object]')
		expect(toolDetails.lines(name, input).join('\n')).toContain('bad')
	}
})

test('multiline and invalid headline fields remain in expanded call details', () => {
	for (let [name, input, detail] of [
		['bash', { command: 'echo ok', description: 123 }, 'description: 123'],
		['bash', { command: 'echo ok', description: 'First\nSecond' }, 'description: First\n  Second'],
		['send', { to: '12-xyz', text: 'Hi', description: false }, 'description: false'],
		['spawn', { name: 'First\nSecond', task: 'Work' }, 'name: First\n  Second'],
		['inspect', { scope: 'all', fields: 'name,\nmodel' }, 'fields: name,\n  model'],
	] as const) expect(toolDetails.lines(name, input).join('\n')).toContain(detail)
	let write = { content: 'new file', path: 'created.txt' }
	expect(toolDetails.headline('write', write).text).toBe('> created.txt')
	expect(toolDetails.lines('write', write)).toEqual(['content: new file'])
})
