import { expect, test } from 'bun:test'
import type { HistoryRecord } from '../common/replay.ts'
import type { Form } from '../common/forms.ts'
import { intro } from './intro.ts'
import { profile } from './profile.ts'

const ts = '2026-10-13T12:00:00Z'
const user = (text: string): HistoryRecord => ({ type: 'user', blocks: [{ type: 'text', text }], ts })
const assistant = (text: string): HistoryRecord => ({ type: 'assistant', block: { type: 'text', text }, ts })
const history = (...records: HistoryRecord[]): HistoryRecord[] =>
	[
		assistant('Hello — I am HAL 9001, your personal agent harness. You can call me Hal.'),
		assistant("I saved your language and tone.\n\nYou're all set. A few tips:"),
		...records,
	].map((r, i) => ({ ...r, n: i + 1 }))
const ask = (form: Form, id: string): HistoryRecord => ({ type: 'question', id, form, ts })
const answer = (form: Form, id: string, value: string): HistoryRecord => ({
	type: 'answer',
	question: id,
	answers: { [form.fields[0]!.name]: value },
	ts,
})

function run(records: HistoryRecord[]) {
	let text = profile.text
	profile.text = () => ''
	try {
		return intro.run(JSON.parse(JSON.stringify(records)))
	} finally {
		profile.text = text
	}
}

test('ELIZA survives replay, keyword help, and rebase follows surviving activation', () => {
	let records = history(user('Start ELIZA'))
	expect(run(records).say).toContain('ELIZA mode')
	records.push(user('How do I login?'))
	expect(run(records).say).toContain('/login')
	records.push(user('I feel worried'))
	expect(run(records).say).toContain('How long have you felt worried?')
	let rebased = [...records, { type: 'rebase', base: 0, drop: [3], edit: [], ts } as HistoryRecord]
	expect(run(rebased).say).toContain("I'm the scripted intro")
	expect(run([...records, user('stop ELIZA')]).say).toContain('Back to the scripted intro')
	let unfinished = [records[0]!, user('Start ELIZA')]
	expect(run(unfinished).ask?.fields[0]?.name).toBe('intro')
})

test('tic-tac-toe replays moves once, validates history, and Escape leaves it', () => {
	let records = history(user('thermonuclear war'))
	let offer = run(records).ask!
	expect(offer.fields[0]).toMatchObject({ options: ['Yes', 'Yes, that would be charming'] })
	records.push(ask(offer, 'war'), answer(offer, 'war', 'Yes'))
	let first = run(records).ask!
	expect(first.fields[0]).toMatchObject({ options: ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3'] })
	records.push(ask(first, 'move'), answer(first, 'move', 'A1'))
	let next = run(records).ask!
	expect(next.fields[0]).toMatchObject({ options: ['B1', 'C1', 'A2', 'C2', 'A3', 'B3', 'C3'] })
	expect(run([...records, records.at(-1)!]).ask).toEqual(next)
	let rewritten = [...records, ask(first, 'stale'), answer(first, 'stale', 'C1')]
	expect(() => run(rewritten)).toThrow('history no longer matches')
	expect(run([...rewritten, user('tic-tac-toe')]).ask).toEqual(first)
	records.push(ask(next, 'next'), { type: 'answer', question: 'next', answers: {}, canceled: true, ts })
	expect(run(records).ask).toBeUndefined()
	expect(run(records).say).toContain('Back to the scripted intro')
})

test('three disclaimers give way to hints and requested tips advance through history', () => {
	let records = history()
	for (let i = 0; i < 3; i++) {
		records.push(user('hello'))
		let reply = run(records)
		expect(reply.ask).toBeUndefined()
		expect(reply.say).not.toContain('Try "Start ELIZA"')
		records.push(assistant(reply.say!))
	}
	records.push(user('hello again'))
	expect(run(records).say).toContain('Try "Start ELIZA"')
	records.push(user('Start ELIZA'), user('tip'))
	let one = run(records).say!
	expect(one).toStartWith("Since you asked, here's a tip:")
	records.push(assistant(one), user('tip'))
	expect(run(records).say).not.toBe(one)
})
