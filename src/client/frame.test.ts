import { expect, test } from 'bun:test'
import { colors } from '../common/colors.ts'
import { modals } from '../common/modals.ts'
import { oklch } from '../common/oklch.ts'
import { strings } from '../common/strings.ts'
import type { Shown as Item, Transcript } from '../common/transcript.ts'
import { settings } from '../common/settings.ts'
import { frame, type View } from './frame.ts'
import { frameLayout } from './frame-layout.ts'
import { ansi } from './ansi.ts'
import { plain, strip, targets, view, useNames } from './frame-fixture.test.ts'

useNames()

test('queued cards expand by inbox ID and their padding matches each sender', () => {
	let v = view([])
	v.transcript!.inbox = [
		{ id: 'a', n: 20, text: 'Agent first\nAgent last', from: 'other', delivery: 'after-turn' },
		{ id: 'b', n: 21, text: 'Human first\nHuman last', delivery: 'after-turn' },
	]
	let closed = frame.build(v, 100).lines
	for (let [text, style] of [
		['Agent first', colors.message()],
		['Human first', colors.user()],
	] as const) {
		let at = closed.findIndex((line) => strip(line).includes(text))
		expect(at).toBeGreaterThan(0)
		expect(closed[at - 1]).toBe(ansi.paint('', style, 100))
		expect(closed[at + 1]).toBe(ansi.paint('', style, 100))
	}
	expect(plain(closed).join('\n')).not.toContain('Agent last')
	v.folds = { states: new Map([['20', 'long']]), sig: '20 long' }
	let opened = plain(frame.build(v, 100).lines).join('\n')
	expect(opened).toContain('Agent last')
	expect(opened).toContain(' m20')
	expect(opened).not.toContain('Human last')
	v.folds = { states: new Map([['20', 'short']]), sig: '20 short' }
	expect(plain(frame.build(v, 100).lines).join('\n')).not.toContain('Agent last')
})

test('EDIT line lists cannot consume the title or block reference', () => {
	let item = {
		type: 'tool',
		id: 'edit',
		name: 'edit',
		input: { path: 'src/host/file-changes.ts' },
		key: '62',
		ts: new Date().toISOString(),
	} as const
	let status = '(+5 −6, lines 6, 25, 28, 31, 37, 42, 59, 71, 100, 120)'
	for (let cols of [40, 60, 100]) {
		let rows = plain(frame.itemRows(item, cols, 's-1', undefined, undefined, undefined, [], status))
		let header = rows.find((r) => r.includes('> '))!
		expect(header).toContain('> src/')
		expect(header).toContain(' t62')
		expect(header).toContain('…')
		expect(strings.visLen(header)).toBeLessThanOrEqual(cols)
	}
})

test('shows every item, however long the history', () => {
	let items: Item[] = []
	for (let i = 0; i < 300; i++)
		items.push({ type: 'prompt', text: `question ${i}` }, { type: 'text', text: `answer ${i}` })
	let lines = plain(frame.build(view(items), 40).lines)
	expect(lines).toContain('question 0')
	expect(lines).toContain('answer 0')
	expect(lines).toContain('answer 299')
	expect(lines.filter((l) => l.startsWith('answer')).length).toBe(300)
})

test('exactly one blank row before Paused., however many newlines the model streamed', () => {
	let items: Item[] = [
		{ type: 'text', text: 'rain\n\n\n  \n' },
		{ type: 'turn-end', status: 'paused' },
	]
	let lines = plain(frame.build(view(items), 40).lines)
	let at = lines.indexOf('Paused.')
	expect(lines.slice(at - 2, at + 1)).toEqual(['rain', '', 'Paused.'])
})

test('the same items drawn again follow a new width and color', () => {
	let v = view([{ type: 'text', text: 'one two three four five six' }])
	let wide = frame.build(v, 40).lines
	expect(frame.build(v, 40).lines).toEqual(wide)
	expect(plain(frame.build(v, 12).lines).slice(0, 6)).toEqual(['', 'Hal', '', 'one two', 'three four', 'five six'])
	let saved = colors.assistant
	try {
		colors.assistant = () => ({ fg: [0.5, 0.1, 30] })
		let fg = `38;2;${oklch.toRgb([0.5, 0.1, 30]).join(';')}`
		expect(frame.build(v, 40).lines[1]).toContain(fg)
	} finally {
		colors.assistant = saved
	}
})

test('no row is wider than the terminal, whatever the text', () => {
	let text = 'wide 漢字漢字漢字 and e\u0301 combining, 👨‍👩‍👧 emoji,\ttabs\tand a verylongwordthatcannotfitanywhere at all'
	let items: Item[] = [
		{ type: 'prompt', text },
		{ type: 'thinking', text },
		{ type: 'text', text },
		{ type: 'tool', id: 't', name: 'bash', input: { command: text } },
		{ type: 'tool', id: 't', name: 'bash', input: { command: text, description: text } },
		{ type: 'tool-result', id: 't', output: text },
		{ type: 'tool-result', id: 't', output: text, isError: true },
		{ type: 'turn-end', status: 'error', error: text },
	]
	for (let cols = 6; cols < 50; cols++) {
		let f = frame.build(view(items, text), cols)
		for (let line of f.lines) {
			expect(strings.visLen(line)).toBeLessThanOrEqual(cols)
			expect(line).not.toContain('\t')
		}
		expect(f.cursor.col).toBeLessThan(cols)
	}
})

test('a tool result of megabytes shows its first rows, each shown line wrapped, the rest counted', () => {
	let long = 'w'.repeat(100)
	let output = [long, ...Array.from({ length: 200_000 }, (_, i) => `row ${i}`)].join('\n')
	let lines = plain(frame.build(view([{ type: 'tool-result', id: 't', output }]), 40).lines).filter((l) =>
		/w|row|more/.test(l),
	)
	// 100 w's on 34 columns wrap to three rows: the first three shown.
	expect(lines.slice(0, 3).every((l) => /^w+$/.test(l))).toBe(true)
	expect(lines.at(-1)).toBe('… 200000 more lines')
})

test('a frame reusing the last one equals a frame built from nothing, as items stream in and change', () => {
	let items: Item[] = [
		{ type: 'prompt', text: 'hi' },
		{ type: 'text', text: 'one' },
	]
	let v = view(items)
	let fresh = (w: View) => {
		let kept = frameLayout.state.history
		frameLayout.state.history = undefined
		let f = frame.build(w, 50, 20, true)
		frameLayout.state.history = kept
		return f.lines
	}
	let steps: View[] = [v]
	let t = v.transcript!
	steps.push({
		...v,
		transcript: { ...t, items: [...t.items, { type: 'tool', id: 'c', name: 'bash', input: {}, key: '7' }] },
	})
	let t2 = steps[1]!.transcript!
	steps.push({
		...v,
		transcript: { ...t2, items: [...t2.items, { type: 'tool-result', id: 'c', output: 'done', key: '~9' }] },
	})
	// A changed item (a new object) in the middle.
	let t3 = steps[2]!.transcript!
	steps.push({
		...v,
		transcript: {
			...t3,
			items: [
				t3.items[0]!,
				{ ...t3.items[1]!, text: 'one, edited' } as (typeof t3.items)[number],
				...t3.items.slice(2),
			],
		},
	})
	steps.push({ ...steps[3]!, prompt: { text: 'typing', cursor: 6 } })
	for (let w of steps) expect(frame.build(w, 50, 20, true).lines).toEqual(fresh(w))
	// Another width lays everything out again.
	let narrow = frame.build(steps[4]!, 30, 20, true).lines
	frameLayout.state.history = undefined
	expect(narrow).toEqual(frame.build(steps[4]!, 30, 20, true).lines)
})

test('text cannot send escape sequences to the terminal', () => {
	let f = frame.build(view([{ type: 'text', text: 'hi\x1b[2J\x1b]0;title\x07\r\nthere' }], 'a\x1bb'), 40)
	for (let line of f.lines) for (let c of ['\x07', '\r']) expect(line).not.toContain(c)
	// Only color (SGR) sequences are left, which move nothing.
	for (let line of f.lines) for (let esc of line.split('\x1b').slice(1)) expect(esc).toMatch(/^\[[\d;]*m/)
	expect(plain(f.lines)).toContain('there')
})

test('inside GNU screen the frame has no color, only reverse video for the selection', () => {
	let env = process.env.STY
	process.env.STY = '1.pts-0.host'
	try {
		let v = view(
			[
				{ type: 'prompt', text: 'hi' },
				{ type: 'text', text: 'hello' },
				{ type: 'output', text: 'boom', error: true },
				{ type: 'tool', id: 't', name: 'bash', input: { command: 'ls' } },
			],
			'draft',
		)
		v.tabs = {
			list: [{ id: 's', name: 's', cwd: '/', model: 'm', state: { type: 'running', phase: 'requesting' } }],
			focused: 's',
		}
		v.notice = 'note'
		let out = frame.build(v, 40).lines.join('\n')
		expect(strip(out)).toContain('hello')
		let modal = frame.build({ ...v, modal: modals.open({ title: 'Models', items: ['a', 'b'] }) }, 40).lines.join('\n')
		for (let s of [out, modal]) expect(s).not.toMatch(/\x1b\[[0-9;]*[34]8;/)
		expect(modal).toContain('\x1b[7m')
	} finally {
		if (env === undefined) delete process.env.STY
		else process.env.STY = env
	}
})

// Local h:m today: older headers carry a date (titles.time).
let today = (h: number, m: number) => {
	let d = new Date()
	d.setHours(h, m, 0, 0)
	return d.toISOString()
}

test('tool and command-output timestamps match prose while machine output stays compact', () => {
	let ts = today(8, 50)
	let f = frame.build(
		view([
			{ type: 'text', text: 'Message body', ts },
			{ type: 'tool', id: 'run', name: 'bash', input: { description: 'Inspect files', command: 'ls' }, ts },
			{ type: 'tool', id: 'read', name: 'read', input: { path: 'example.txt' }, ts },
			{ type: 'output', text: 'Command body', ts },
		]),
		80,
	)
	let lines = plain(f.lines)
	let ordinary = lines.findIndex((line) => line.startsWith('08:50 Hal'))
	let output = lines.findIndex((line) => line === '08:50')
	expect(lines[ordinary + 1]).toBe('')
	expect(lines[ordinary + 2]).toBe('Message body')
	expect(lines[output + 1]).toBe('Command body')
	expect(lines.some((line) => line.startsWith('08:50 $ Inspect files'))).toBe(true)
	expect(lines.some((line) => line.startsWith('08:50 < example.txt'))).toBe(true)
})

test('finished thinking with no readable text draws nothing, not a bare header', () => {
	let lines = plain(
		frame.build(
			view([
				{ type: 'thinking', text: '', model: 'anthropic/claude-opus-5-5' },
				{ type: 'text', text: 'hi' },
			]),
			60,
		).lines,
	)
	expect(lines.join('\n')).not.toContain('thinking')
	expect(lines.join('\n')).toContain('hi')
})

test('Bash results link to the call; a failed status and the time go in the title, in the warning color (task wm0)', () => {
	let v = view([
		{ type: 'tool', id: 'run', name: 'bash', input: { description: 'Check files', command: 'git status --short' } },
		{ type: 'tool-result', id: 'run', output: '[exit 0]\n M notes.md\n' },
		{ type: 'tool', id: 'bad', name: 'bash', input: { description: 'Read missing', command: 'cat nope' } },
		{ type: 'tool-result', id: 'bad', output: '[exit 123]\nerror: cannot access file\n', ms: 3270 },
		{ type: 'prompt', text: '[exit 123]\nmissing file\n', from: 's', label: 'bash #1813' },
	])
	v.transcript!.items = v.transcript!.items.map((item, i) => ({
		...item,
		key: ['1813', '1814', '1815', '1816', '1817'][i]!,
	}))
	v.transcript!.meta.blocks = { tool: 'short' }
	let lines = frame.build(v, 70).lines
	let printed = plain(lines).join('\n')
	expect(printed).not.toContain('[exit 0]')
	// Under its call, a result needs no link back to it; apart, it has one.
	expect(printed).toContain('\nM notes.md')
	expect(printed).not.toContain('#1813>')
	let title = lines.find((line) => line.includes('Read missing'))!
	expect(plain([title])[0]).toMatch(/Read missing: cat nope +\(exit 123, 3\.2s\) t1815$/)
	expect(title).toContain(ansi.sgr({ fg: colors.exit().fg! }) + 'exit 123')
	expect(printed).not.toContain('[exit 123]\nerror')
	expect(printed).toContain('error: cannot access file')
	let jobTitle = lines.find((line) => line.includes('git status --short') && line.includes('s1817'))!
	expect(plain([jobTitle])[0]).toMatch(/\$ git status --short +\(exit 123\) s1817$/)
	expect(jobTitle).toContain(ansi.sgr({ fg: colors.exit().fg! }) + 'exit 123')
	expect(printed).not.toContain('[exit 123]')
	let apart = view([v.transcript!.items[0]!, { type: 'text', text: 'meanwhile' }, v.transcript!.items[1]!])
	apart.transcript!.items = apart.transcript!.items.map((item, i) => ({ ...item, key: ['1813', '1818', '1814'][i]! }))
	let detached = plain(frame.build(apart, 70).lines).find((line) => line.includes('M notes.md'))!
	expect(detached).toBe('M notes.md')
	expect(plain(frame.build(apart, 70).lines).find((line) => line.includes('Result of:'))).toMatch(
		/^Result of: \$ Check files +t1813/,
	)
	expect(targets(frame.build(apart, 70).lines)).toContain(`${settings.webUrl()}/s#t1813`)
	expect(printed).not.toContain('Background command finished')
	for (let width of [40, 50, 70])
		for (let label of ['bash #1813', 'bash #t1813', 'bash t1813']) {
			let job = view([{ type: 'prompt', text: '[exit 123]\nmissing file', from: 's', label }])
			let rendered = frame.build(job, width).lines
			let ref = label.slice(5).replace(/^#/, '')
			expect(targets(rendered)).toContain(`${settings.webUrl()}/s#${ref}`)
			expect(plain(rendered).join('\n')).toContain(ref)
		}
})

test('long streaming tool cards keep a bounded tail, then expand on completion', () => {
	let output = Array.from({ length: 100 }, (_, i) => `output ${i}`).join('\n')
	let v = view([{ type: 'tool', id: 'bounded', name: 'bash', input: { command: './test' }, partial: output }])
	v.transcript!.meta.blocks = { tool: 'long' }
	let running = frame.build(v, 80, 60)
	expect(running.history).toBeLessThanOrEqual(22)
	let text = plain(running.lines).join('\n')
	expect(text).toContain('output 99')
	expect(text).not.toContain('output 0\n')
	let resized = frame.build(v, 80, 40)
	expect(resized.history).toBeLessThanOrEqual(12)
	v.transcript!.items = [
		{ ...v.transcript!.items[0]!, partial: undefined } as Transcript['items'][number],
		{ type: 'tool-result', id: 'bounded', output, key: '~result' },
	]
	let finished = frame.build(v, 80, 60)
	expect(finished.history).toBeGreaterThan(100)
	expect(plain(finished.lines).join('\n')).toContain('output 0\n')
	expect(plain(finished.lines).join('\n')).not.toContain('Result of:')
	let parallel = view([
		{ type: 'tool', id: 'parallel-first', name: 'bash', input: { command: './test' }, partial: output },
		{ type: 'tool', id: 'parallel-second', name: 'read', input: { path: 'README.md' } },
	])
	parallel.transcript!.meta.blocks = { tool: 'long' }
	let split = plain(frame.build(parallel, 80, 60).lines).join('\n')
	expect(split).toContain('Result of: $ ./test')
	expect(split).toContain('output 99')
	expect(split).not.toContain('output 0\n')
})

test('legacy rename controls never appear in terminal answers without a naming flag', () => {
	let f = frame.build(
		view([{ type: 'text', text: 'Done.\n<rename>Fix replay persistence</rename>\n<summary>Fixed</summary>' }]),
		80,
	)
	let text = plain(f.lines).join('\n')
	expect(text).toContain('Done.')
	expect(text).not.toContain('Fix replay persistence')
	expect(text).not.toContain('<rename>')
})

test('a batch seen running keeps its output and results below its calls until a rebuild', () => {
	type Row = Parameters<typeof frame.order>[0][number]
	let call = (id: string, partial?: string) =>
		({ type: 'tool', id, name: 'inspect', input: {}, key: `t${id}`, ...(partial && { partial }) }) as Row
	let result = (id: string) => ({ type: 'tool-result', id, output: 'x', key: `r${id}` }) as Row
	let keys = (items: Row[]) =>
		frame
			.order(items)
			.map((i) => i.key)
			.join(' ')
	let done = [call('a'), call('b'), result('b'), result('a')]
	expect(keys(done)).toBe('ta ra tb rb')
	let running = [call('c', 'out'), call('d')]
	expect(keys(running)).toBe('tc td tc~live')
	expect(keys([...running.map((c) => ({ ...c, partial: undefined }) as Row), result('d'), result('c')])).toBe(
		'tc td rd rc',
	)
})

test('interruption markers remain whole and colored at a full terminal row', () => {
	for (let n of [47, 48]) {
		let rows = frame.itemRows({ type: 'text', text: 'x'.repeat(n), interrupted: true, key: '~cut' }, 50)
		expect(plain(rows).at(-1)).toBe('--')
		expect(rows.at(-1)).toContain(ansi.sgr({ fg: colors.log().fg! }) + '--')
		expect(plain(rows).join('')).toContain('x'.repeat(n) + '--')
	}
})

test('help and rebase command cards open directly to full input and output without changing other commands', () => {
	for (let command of ['/help rebase', '/rebase show', '/rename Example']) {
		let v = view([
			{ type: 'tool', id: 'c', name: 'command', input: { command } },
			{ type: 'tool-result', id: 'c', output: Array.from({ length: 240 }, (_, i) => `output ${i}`).join('\n') },
		])
		let closed = plain(frame.build(v, 70).lines).join('\n')
		if (command !== '/rename Example') expect(closed).not.toContain('output 0')
		v.folds = { states: new Map([['~0', 'long']]), sig: 'long' }
		let opened = plain(frame.build(v, 70).lines).join('\n')
		expect(opened).toContain(command)
		if (command !== '/rename Example') {
			expect(opened).toContain('output 239')
			expect(opened).not.toContain('more lines')
		} else expect(opened).toContain('more lines')
	}
})

test('rebase reports show colored edits immediately, separately from an earlier editor error', () => {
	let report =
		'Rebase applied (dropped 11 entries, edited 1)\nDropped 11 entries: #170-180 (11 entries)\n--paused\nEdited #169 user:\n```diff\n-old\n+replacement\n```'
	let v = view([
		{ type: 'output', text: 'Rebase failed: editor exited with code 1', error: true },
		{ type: 'output', text: report },
	])
	let rows = frame.build(v, 80).lines
	let text = plain(rows).join('\n')
	expect(text).toContain('Rebase failed: editor exited with code 1')
	expect(text).toContain('dropped 11 entries, edited 1')
	expect(text).toContain('--paused')
	expect(text).toContain('Edited #169')
	expect(text).not.toContain('```')
	for (let [line, fg] of [
		['-old', colors.diff().removeFg],
		['+replacement', colors.diff().addFg],
	] as const) {
		expect(rows.find((r) => plain([r])[0]!.includes(line))).toContain(ansi.sgr({ fg: fg! }))
	}
})

test('idle cursor has one blank row after text, fences and whitespace tails', () => {
	for (let text of ['last line', 'last line\n\n  \n', '```diff\n-last line\n+last line\n```']) {
		let v = view([{ type: 'output', text }])
		v.hal = { at: 'idle', lit: true, color: [0.7, 0, 0] }
		let lines = plain(frame.build(v, 80).lines)
		let at = lines.findIndex((line) => line === '█')
		expect(at).toBeGreaterThan(1)
		expect(lines[at - 1]).toBe('')
		expect(lines[at - 2]).toContain('last line')
	}
})

test('receipt ticks follow waiting messages into history and leave optimistic and immediate prompts unmarked', () => {
	let v = view([])
	v.transcript!.inbox = [
		{ id: 'soft', text: 'pending soft', delivery: 'next-round' },
		{ id: 'queue', text: 'pending queue', delivery: 'after-turn' },
	]
	v.pending = ['optimistic prompt']
	let waiting = plain(frame.build(v, 90).lines)
	expect(waiting.filter((l) => l.includes('✓'))).toHaveLength(2)
	expect(waiting.some((l) => l.includes('✓✓'))).toBe(false)
	expect(waiting.find((l) => l.includes('optimistic prompt'))).not.toContain('✓')
	let read = plain(
		frame.build(
			view([
				{ type: 'prompt', text: 'read soft', delivery: 'next-round' },
				{ type: 'prompt', text: 'read queue', delivery: 'after-turn' },
				{ type: 'prompt', text: 'immediate', delivery: 'now' },
			]),
			90,
		).lines,
	)
	expect(read.filter((l) => l.includes('✓✓'))).toHaveLength(2)
})
