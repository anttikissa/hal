// Sync only portable config settings while keeping each home's local settings.
import * as ason from '../common/ason.ts'
import { settings } from '../common/settings.ts'

function portable(key: string): boolean {
	return settings.table.some((s) => s.name === key.replace(/^blockVerbosity/, 'cardVerbosity') && s.portable !== false)
}

function parse(bytes?: Uint8Array, incoming = false): ason.AsonObject {
	let data = bytes === undefined ? {} : ason.parse(Buffer.from(bytes).toString('utf8'), { comments: true })
	if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('config.ason: expected an object')
	if (incoming)
		for (let key of Object.keys(data))
			if (!configSync.portable(key)) throw new Error(`config.ason: incoming setting ${key} is not portable here`)
	return data
}

// A trailing comma after the last setting keeps an added setting a
// one-line change.
function text(data: ason.AsonObject): string {
	return ason.stringify(data, { mode: 'long', indent: '\t', tabWidth: 4 }).replace(/([^,{\n])\n}$/, '$1,\n}') + '\n'
}

// The compared and shown text: the root comment and the portable settings
// with their comments, in the file's order.
function view(bytes?: Uint8Array): Buffer | undefined {
	let data = configSync.parse(bytes)
	let result = text(build(data, Object.keys(data).filter(configSync.portable), () => data))
	return result === '{}\n' ? undefined : Buffer.from(result)
}

// Inserts each key of `from` missing in `into` after the key it follows
// in `from`, so settings keep their neighbors.
function weave(into: string[], from: string[]): string[] {
	let prev: string | undefined
	for (let key of from) {
		if (!into.includes(key)) into.splice(prev === undefined ? 0 : into.indexOf(prev) + 1, 0, key)
		prev = key
	}
	return into
}

// Rewrites `into` with `keys`, taking each value and comment from the
// object `source(key)` names; other keys go. Its root comment stays.
function build(into: ason.AsonObject, keys: string[], source: (key: string) => ason.AsonObject): ason.AsonObject {
	let comments: Record<string, string> = {}
	let picked = keys.flatMap((key) => {
		let from = source(key)
		return Object.hasOwn(from, key) ? [[key, from[key], from[ason.COMMENTS]?.[key]] as const] : []
	})
	for (let key of Object.keys(into)) delete into[key]
	for (let [key, value, note] of picked) {
		into[key] = value
		if (note !== undefined) comments[key] = note
	}
	into[ason.COMMENTS] = comments
	return into
}

// A three-way merge of portable views, one setting at a time. A value or
// comment changed on one side only takes that change; changed differently
// on both, the client's stays. Only values count as conflicts.
function combine(base: string | undefined, client: string, server: string): { text: string; conflicts: number } {
	let [b, c, s] = [base, client, server].map((t) => configSync.parse(t === undefined ? undefined : Buffer.from(t)))
	let conflicts = 0
	let pick = (get: (o: ason.AsonObject) => string | undefined) => {
		let [x, y, z] = [b!, c!, s!].map(get)
		return { from: y === x ? s! : c!, conflict: y !== z && y !== x && z !== x }
	}
	let result = build(c!, weave(Object.keys(c!), Object.keys(s!)), (key) => {
		let p = pick((o) => (Object.hasOwn(o, key) ? ason.stringify(o[key]) : undefined))
		if (p.conflict) conflicts++
		return p.from
	})
	let comments = result[ason.COMMENTS]!
	for (let key of Object.keys(result)) {
		let note = pick((o) => o[ason.COMMENTS]?.[key]).from[ason.COMMENTS]?.[key]
		if (note === undefined) delete comments[key]
		else comments[key] = note
	}
	return { text: text(result), conflicts }
}

// Applies the portable view `incoming` to the local file setting by
// setting: its root comment, then local settings (webUrl, webPort), then
// the portable settings with incoming values, comments and order; an
// unknown setting keeps its value, comment and neighbor.
function merge(local: Uint8Array | undefined, incoming: Uint8Array | undefined): Buffer {
	let data = configSync.parse(incoming, true)
	let mine = configSync.parse(local)
	let first = Object.keys(mine).filter((key) => !configSync.portable(key) && settings.table.some((s) => s.name === key))
	let rest = Object.keys(mine).filter((key) => !configSync.portable(key) || Object.hasOwn(data, key))
	let keys = weave([...first, ...Object.keys(data)], rest)
	build(data, keys, (key) => (Object.hasOwn(data, key) ? data : mine))
	// As the live config file writes it (live-file.ts)
	return Buffer.from(ason.stringify(data) + '\n')
}

export const configSync = { portable, parse, view, combine, merge }
