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

function text(data: ason.AsonObject): string {
	return ason.stringify(data, { mode: 'long', indent: '\t', tabWidth: 4 }) + '\n'
}

function view(bytes?: Uint8Array): Buffer | undefined {
	let data = configSync.parse(bytes)
	// Re-adding keys in sorted order makes a moved setting no change
	for (let key of Object.keys(data).sort()) {
		let value = data[key]!
		delete data[key]
		if (configSync.portable(key)) data[key] = value
	}
	let result = text(data)
	return result === '{}\n' ? undefined : Buffer.from(result)
}

function merge(local: Uint8Array | undefined, incoming: Uint8Array | undefined): Buffer {
	let data = configSync.parse(incoming, true)
	let kept = configSync.parse(local)
	for (let key of Object.keys(kept)) if (configSync.portable(key)) delete kept[key]
	let result = { ...data, ...Object.fromEntries(Object.entries(kept)) }
	result[ason.COMMENTS] = {
		...data[ason.COMMENTS],
		...Object.fromEntries(Object.entries(kept[ason.COMMENTS] ?? {}).filter(([key]) => Object.hasOwn(kept, key))),
	}
	return Buffer.from(text(result))
}

export const configSync = { portable, parse, view, merge }
