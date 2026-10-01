// Validation of host events on the client side; protocol.ts holds the types.
import type { EventType } from './protocol.ts'

// What each event carries, checked by clients (connection.ts) before
// use: a page or terminal can outlive a host restart onto newer code.
// s: string, i: integer, o: object, a: list, S: list of strings, with
// ? for optional. Nested fields are named with a dot.
const eventFields: Record<EventType, Record<string, string>> = {
	'find-results': { request: 's', tier: 's', results: 'a', done: 'b', scanning: 'i?', error: 's?' },
	snapshot: { sessionId: 's', snapshot: 'o', 'snapshot.meta': 'o', 'snapshot.history': 'a', 'snapshot.state': 'o', 'snapshot.stats': 'o?' },
	'turn-start': { sessionId: 's', provider: 's', model: 's?', effort: 's?', prompt: 's?', images: 'a?', command: 's?', ts: 's?' },
	history: { sessionId: 's', before: 'i', records: 'a', older: 'i?' },
	state: { sessionId: 's', state: 'o', 'state.type': 's' },
	inbox: { sessionId: 's', inbox: 'a' },
	prompt: { sessionId: 's', texts: 'S', senders: 'a?', images: 'a?', command: 's?', ts: 's?' },
	stream: { sessionId: 's', event: 'o', 'event.type': 's', ts: 's?', model: 's?', effort: 's?' },
	'tool-output': { sessionId: 's', id: 's', at: 'i', chunk: 's' },
	'tool-results': { sessionId: 's', results: 'a' },
	'turn-stats': { sessionId: 's', stats: 'o' },
	'turn-end': { sessionId: 's', status: 's', usage: 'o?', error: 's?', stats: 'o?' },
	question: { sessionId: 's', id: 's', form: 'o' },
	answer: { sessionId: 's', question: 's', answers: 'o', secrets: 'S?' },
	command: { sessionId: 's', text: 's', from: 's?', origin: 's?', command: 's?' },
	output: { sessionId: 's', text: 's', ts: 's?' },
	divider: { sessionId: 's', text: 's' },
	meta: { sessionId: 's', meta: 'o', stats: 'o?' },
	completions: { sessionId: 's', text: 's', items: 'S', descriptions: 'S?' },
	models: { sessionId: 's', current: 's', items: 'S', effort: 's?', capabilities: 'o?' },
	attached: { sessionId: 's', command: 's', blob: 's', marker: 's' },
	warning: { text: 's' },
	'push-devices': { devices: 'a', result: 's?' },
	version: { version: 's' },
	'model-names': { names: 'o' },
	notice: { session: 's', tab: 'i?', name: 's', kind: 's', line: 's', key: 's?', what: 's?' },
	tabs: { tabs: 'a' },
	go: { sessionId: 's', tab: 's' },
	draft: { sessionId: 's', draft: 'o', 'draft.text': 's', 'draft.rev': 'i', command: 's?' },
	rejected: { sessionId: 's?', command: 's', reason: 's', id: 's?' },
	ack: { id: 's', tab: 's?' },
	restart: {},
	'web-update': {},
	redraw: { sessionId: 's' },
	auth: { code: 's', link: 's?' },
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
	if (value.type === 'command' && value.origin !== undefined && value.origin !== 'model') return 'command: origin must be model'
	if (value.type === 'completions' && value.descriptions !== undefined && (value.descriptions as string[]).length !== (value.items as string[]).length) return 'completions: descriptions must align with items'
	if (value.type === 'tabs' && !(value.tabs as unknown[]).every((t) => isObject(t) && ['id', 'name', 'cwd'].every((k) => typeof t[k] === 'string'))) return 'tabs: every tab needs an id, name and cwd'
	if (value.type === 'find-results') {
		let tiers = ['metadata', 'user', 'assistant', 'thinking', 'tool-call', 'tool-output', 'other']
		if (!tiers.includes(value.tier as string)) return 'find-results: invalid tier'
		let valid = (value.results as unknown[]).every((r) => isObject(r) && ['sessionId', 'name', 'blockId', 'snippet', 'href'].every((k) => typeof r[k] === 'string') && tiers.includes(r.kind as string) && typeof r.age === 'number' && Number.isFinite(r.age) && typeof r.score === 'number' && Number.isFinite(r.score))
		if (!valid) return 'find-results: invalid result'
	}
	return undefined
}

export const eventCheck = { invalidEvent }
