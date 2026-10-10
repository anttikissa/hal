// Validation of host events on the client side; protocol.ts holds the types.
// Tasks: qt, 6eq, 81y.
import { sender } from './sender.ts'
import type { EventType } from './protocol.ts'
import { pluginSyncWire } from './plugin-sync.ts'

// What each event carries, checked by clients (connection.ts) before
// use: a page or terminal can outlive a host restart onto newer code.
// s: string, i: integer, o: object, a: list, S: list of strings, with
// ? for optional. Nested fields are named with a dot.
const eventFields: Record<EventType, Record<string, string>> = {
	'subscription-usage': { accounts: 'o', replace: 'b?' },
	'find-results': { request: 's', tier: 's', results: 'a', done: 'b', scanning: 'i?', error: 's?' },
	'rebase-result': { sessionId: 's', command: 's?', ok: 'b', text: 's' },
	'rebase-plan': { sessionId: 's', snapshot: 'o', 'snapshot.base': 'i', 'snapshot.rows': 'a', 'snapshot.records': 'a', 'snapshot.options': 'o', todo: 's' },
	'history-rewritten': { sessionId: 's', from: 'i', snapshot: 'o', 'snapshot.meta': 'o', 'snapshot.history': 'a', 'snapshot.state': 'o', 'snapshot.queueHold': 's?' },
	snapshot: { sessionId: 's', snapshot: 'o', 'snapshot.meta': 'o', 'snapshot.history': 'a', 'snapshot.state': 'o', 'snapshot.stats': 'o?', 'snapshot.queueHold': 's?' },
	'turn-start': { inbox: 'S?', sessionId: 's', provider: 's', model: 's?', effort: 's?', prompt: 's?', images: 'a?', command: 's?', ts: 's?' },
	history: { sessionId: 's', before: 'i', records: 'a', older: 'i?' },
	toggle: { sessionId: 's', target: 's', mode: 's?' },
	'paste-text': { sessionId: 's', name: 's', text: 's?', error: 's?' },
	state: { sessionId: 's', state: 'o', 'state.type': 's' },
	inbox: { sessionId: 's', inbox: 'a' },
	'queue-edit': { sessionId: 's', edit: 's', message: 's', text: 's' },
	'queue-hold': { sessionId: 's', message: 's?' },
	prompt: { inbox: 'S?', sessionId: 's', texts: 'S', senders: 'a?', images: 'a?', command: 's?', ts: 's?' },
	stream: { sessionId: 's', event: 'o', 'event.type': 's', ts: 's?', model: 's?', effort: 's?' },
	'assistant-interrupted': { sessionId: 's', record: 'o', 'record.type': 's', 'record.block': 'o', 'record.block.type': 's', 'record.block.text': 's', 'record.interrupted': 'b', 'record.n': 'i', 'record.ts': 's', 'record.model': 's?', 'record.effort': 's?' },
	'tool-output': { sessionId: 's', id: 's', at: 'i', chunk: 's' },
	'tool-results': { sessionId: 's', results: 'a' },
	'turn-stats': { sessionId: 's', stats: 'o' },
	'turn-end': { sessionId: 's', status: 's', usage: 'o?', error: 's?', stats: 'o?' },
	question: { sessionId: 's', id: 's', form: 'o' },
	answer: { sessionId: 's', question: 's', answers: 'o', secrets: 'S?' },
	command: { sessionId: 's', text: 's', from: 's?', label: 's?', origin: 's?', command: 's?' },
	output: { sessionId: 's', text: 's', ts: 's?', origin: 's?' },
	divider: { sessionId: 's', text: 's' },
	meta: { sessionId: 's', meta: 'o', stats: 'o?' },
	completions: { sessionId: 's', text: 's', items: 'S', descriptions: 'S?' },
	models: { sessionId: 's', current: 's', items: 'S', effort: 's?', capabilities: 'o?' },
	attached: { sessionId: 's', command: 's', blob: 's', marker: 's' },
	settings: { sessionId: 's?', values: 'o', stored: 'o' },
	warning: { text: 's' },
	'restart-ask': { sessionId: 's', scope: 's', calls: 'a' },
	'push-devices': { devices: 'a', result: 's?' },
	'notice-history': { entries: 'a' },
	version: { version: 's' },
	home: { path: 's' },
	'model-names': { names: 'o', defaults: 'o?' },
	notice: { session: 's', tab: 'i?', name: 's', kind: 's', line: 's', key: 's?', what: 's?' },
	tabs: { tabs: 'a', subscriptions: 'o?' },
	go: { sessionId: 's', tab: 's', block: 's?' },
	draft: { sessionId: 's', draft: 'o', 'draft.text': 's', 'draft.rev': 'i', command: 's?' },
	rejected: { sessionId: 's?', command: 's', reason: 's', id: 's?' },
	ack: { id: 's', tab: 's?' },
	restart: {},
	'web-update': {},
	redraw: { sessionId: 's' },
	auth: { code: 's', link: 's?' },
	'plugin-sync': { request: 's?', changed: 'b?', stale: 'b?', applied: 'b?', home: 's?', ignored: 'S?', heads: 'a?', versions: 'a?', contents: 'o?', head: 'o?', review: 's?', answers: 'o?' },
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const kinds: Record<string, (v: unknown) => boolean> = {
	s: (v) => typeof v === 'string',
	b: (v) => typeof v === 'boolean',
	i: (v) => Number.isInteger(v),
	o: isObject,
	a: Array.isArray,
	S: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
}
const kindNames: Record<string, string> = { s: 'a string', b: 'a boolean', i: 'an integer', o: 'an object', a: 'a list', S: 'a list of strings' }

// Why `value` is not an event this client understands, or undefined.
function invalidEvent(value: unknown): string | undefined {
	if (!isObject(value)) return 'event must be an object'
	if (typeof value.type !== 'string' || !Object.hasOwn(eventFields, value.type)) return `unknown event type ${JSON.stringify(value.type)}`
	for (let [path, kind] of Object.entries({ ...eventFields[value.type as EventType], n: 'i?' })) {
		let v = path.split('.').reduce<unknown>((o, key) => (isObject(o) ? o[key] : undefined), value)
		if (v === undefined && kind.endsWith('?')) continue
		if (!kinds[kind[0]!]!(v)) return `${value.type}: ${path} must be ${kindNames[kind[0]!]}`
	}
	if (value.type === 'subscription-usage' || (value.type === 'tabs' && value.subscriptions !== undefined)) {
		let unsafe = (key: string) => ['__proto__', 'constructor', 'prototype'].includes(key)
		for (let [key, windows] of Object.entries((value.type === 'tabs' ? value.subscriptions : value.accounts) as Record<string, unknown>)) {
			if (unsafe(key) || !isObject(windows) || Object.keys(windows).some(unsafe) || Object.values(windows).some((w) => !isObject(w) || typeof w.used !== 'number' || !Number.isFinite(w.used) || w.used < 0 || w.used > 100 || (w.resets !== undefined && (typeof w.resets !== 'string' || !Number.isFinite(Date.parse(w.resets)))) || (w.observed !== undefined && (typeof w.observed !== 'string' || !Number.isFinite(Date.parse(w.observed)))))) return `${value.type}: invalid windows`
		}
	}
	if (value.type === 'assistant-interrupted') {
		let r = value.record as Record<string, unknown>
		if (r.type !== 'assistant' || (r.block as Record<string, unknown>).type !== 'text' || r.interrupted !== true || !Number.isSafeInteger(r.n) || (r.n as number) < 1 || !Number.isFinite(Date.parse(r.ts as string))) return 'assistant-interrupted: invalid interrupted text record'
	}
	let senders = value.type === 'prompt' ? value.senders ?? [] : value.type === 'turn-start' && value.sender !== undefined ? [value.sender] : value.type === 'inbox' ? value.inbox : []
	if (!Array.isArray(senders) || senders.some((s) => sender.invalid(s))) return `${value.type}: invalid sender metadata`
	if ((value.type === 'command' || value.type === 'output') && value.origin !== undefined && value.origin !== 'model') return `${value.type}: origin must be model`
	if (value.type === 'completions' && value.descriptions !== undefined && (value.descriptions as string[]).length !== (value.items as string[]).length) return 'completions: descriptions must align with items'
	if (value.type === 'tabs' && !(value.tabs as unknown[]).every((t) => isObject(t) && ['id', 'name', 'cwd'].every((k) => typeof t[k] === 'string'))) return 'tabs: every tab needs an id, name and cwd'
	if (value.type === 'plugin-sync') return pluginSyncWire.invalidEvent(value)
	if (value.type === 'find-results') {
		let tiers = ['metadata', 'user', 'assistant', 'thinking', 'tool-call', 'tool-output', 'other']
		if (!tiers.includes(value.tier as string)) return 'find-results: invalid tier'
		let valid = (value.results as unknown[]).every((r) => isObject(r) && ['sessionId', 'name', 'blockId', 'snippet', 'href'].every((k) => typeof r[k] === 'string') && tiers.includes(r.kind as string) && typeof r.age === 'number' && Number.isFinite(r.age) && typeof r.score === 'number' && Number.isFinite(r.score))
		if (!valid) return 'find-results: invalid result'
	}
	return undefined
}

export const eventCheck = { invalidEvent }
