import { expect, test } from 'bun:test'
import { settings } from '../common/settings.ts'
import { itemView } from './item-view.ts'
import { toolView } from './tool-view.ts'

test('an image block’s label links to the image', () => {
	let item = { type: 'image', blob: 'abc123def456', mediaType: 'image/png', bytes: 27000, key: '~0' } as const
	let url = `http://localhost:${settings.webPort()}/blob/s-1/abc123def456`
	expect(itemView.itemLines(item as any, 60, false, 's-1')).toEqual([`\x1b]8;;${url}\x07[image 27 kB png]\x1b]8;;\x07`])
	expect(itemView.itemLines(item as any, 60)).toEqual(['[image 27 kB png]'])
})

test('answers with only hidden controls or whitespace have no terminal card', () => {
	for (let text of ['', ' \n\t', '<summary></summary>', '<rename>New name</rename>']) {
		let item = { type: 'text', text, key: '12', ts: '2026-10-06T22:09:00Z', model: 'fake/model' } as const
		for (let fold of ['long', 'short'] as const) {
			expect(itemView.itemLines(item, 60, false, 's-1', undefined, undefined, [], { fold })).toEqual([])
			expect(itemView.itemLines(item, 60, true, 's-1', undefined, undefined, [], { fold })).toEqual([''])
		}
	}
	let item = { type: 'text', text: '<summary>Stopped.</summary>' } as const
	let rows = itemView.itemLines(item, 60)
	expect(rows.join('\n')).toContain('Stopped.')
	expect(rows.join('\n')).not.toContain('<summary>')
	// Literal markup in code is content, not a hidden control.
	expect(itemView.itemLines({ type: 'text', text: '`<summary>Stopped.</summary>`' }, 60).length).toBeGreaterThan(0)
})

test('tool errors without exit codes or timings remain visible in the title status', () => {
	let error = { output: 'Error: malformed arguments', isError: true }
	let status = (item: typeof error & { interrupted?: 'canceled' | 'stopped' }, bash = false) => Bun.stripANSI(toolView.resultStatus(item, bash, undefined))
	expect(status(error)).toBe('(failed)')
	expect(status(error, true)).toBe('(failed)')
	expect(status({ ...error, output: '[exit 2]\ncommand failed' }, true)).toBe('(exit 2)')
	expect(status({ ...error, interrupted: 'canceled' })).toBe('(canceled)')
	expect(status({ output: 'Success', isError: false })).toBe('')
})

test('interrupted text decorates its end, preserving trailing spaces and line breaks', () => {
	for (let [text, end] of [['partial', 'partial --'], ['partial ', 'partial --'], ['partial\n', 'partial\n--'], ['', '--']] as const) {
		let item = { type: 'text' as const, text: text!, interrupted: true as const }
		let rows = itemView.itemLines(item, 60)
		let plain = rows.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
		expect(plain.endsWith(end!)).toBe(true)
		expect(item.text).toBe(text)
	}
})

test('expanded tool cards preserve wrapped headlines, complete arguments and multiline shell commands', () => {
	let render = (name: string, input: Record<string, unknown>, fold: 'long' | 'short' = 'long') => itemView.itemLines({ type: 'tool', name, input, id: 'internal' }, 30, false, undefined, undefined, undefined, [], { fold }).map(Bun.stripANSI).join('\n')
	let spawn = render('spawn', { name: 'A long session name that must not be clipped', task: 'First instruction\nSecond instruction', model: 'fake/model' })
	expect(spawn.replace(/\n/g, ' ')).toContain('must not be clipped')
	expect(spawn).toContain('task: First instruction\n  Second instruction')
	expect(spawn).toContain('model: fake/model')
	let bash = render('bash', { command: 'echo first\necho second', description: 'Two commands', modifies: ['a.ts'], timeout: 5 })
	expect(bash).toContain('$ Two commands\necho first\necho second')
	expect(bash).toContain('Edits a.ts')
	expect(bash).not.toContain('Timeout')
	expect(render('tool', { cmd: 'READ { broken:' })).toContain('cmd: READ { broken:')
})

test('A short Bash card shows its command in its rows, with stable live and finished height', () => {
	let ts = '2026-10-15T07:00:00.000Z'
	let item = { type: 'tool' as const, name: 'bash', input: { command: 'echo first\n' + 'echo later\n'.repeat(20), description: 'Run commands' }, id: 'bash', ts }
	let rows = (partial?: string) => toolView.call({ ...item, partial }, 40, 'short', {}).map(Bun.stripANSI)
	expect(rows()[1]).toBe('echo first ↵ … ↵ echo later')
	expect(rows()).toHaveLength(2)
	let output = 'first\nsecond'
	let finished = toolView.result({ type: 'tool-result', id: 'bash', output: '[exit 0]\n' + output }, 40, 'short', { head: 2 }, undefined, '1', 'bash')
	expect(rows(output).length).toBe(rows().length + finished.length)
	// A short one-line command goes after the title; a long one scrolls
	// from its start to its end, then stays there.
	expect(toolView.call({ ...item, input: { command: 'ls', description: 'List' } }, 40, 'short', {}).map(Bun.stripANSI)).toEqual([expect.stringMatching(/List {3}ls$/)])
	expect(toolView.call({ ...item, input: { command: 'ls' } }, 40, 'short', {}).map(Bun.stripANSI)).toEqual([expect.stringMatching(/\$ ls$/)])
	let long = { ...item, input: { command: 'echo ' + 'x'.repeat(60) + ' end', description: 'Echo' } }
	let at = (ms: number) => Bun.stripANSI(toolView.call(long, 20, 'short', { now: Date.parse(ts) + ms })[1]!)
	expect(at(0)).toMatch(/^echo x+…$/)
	expect(at(100)).toMatch(/^…x+…$/)
	expect(at(10_000)).toMatch(/^…x+ end$/)
	expect(Bun.stripANSI(toolView.call(long, 20, 'short', {})[1]!)).toBe(at(10_000))
	expect(Bun.stringWidth(at(100))).toBe(20)
	expect(toolView.call(item, 20, 'long', {}).join('\n')).toContain('echo later')
})

test('background reports and thinking start short, expand fully, and SEND shows /close', () => {
	for (let label of ['bash #t19', 'bash b123abc']) {
		let item = { type: 'prompt' as const, text: '[exit 1]\nfirst\nsecond\nthird\nlast', from: 'self', label, delivery: 'next-round' as const }
		expect(itemView.itemLines(item, 100).join('\n')).not.toContain('last')
		expect(itemView.itemLines(item, 100, false, undefined, undefined, undefined, [], { fold: 'long' }).join('\n')).toContain('last')
		expect(itemView.receipt(item)).toBe('')
	}
	let thinking = { type: 'thinking' as const, text: 'first\n\nsecond\n\nlast' }
	expect(itemView.itemLines(thinking, 80).join('\n')).not.toContain('last')
	expect(itemView.itemLines(thinking, 80, false, undefined, undefined, undefined, [], { fold: 'long' }).join('\n')).toContain('last')
	let send = { type: 'tool' as const, id: 's', name: 'send', input: { to: '42', text: '/close' } }
	expect(itemView.itemLines(send, 24)[0]).toContain('/close')
})
