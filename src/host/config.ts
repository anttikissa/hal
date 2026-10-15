// config.ason: the common settings (declared in src/common/settings.ts)
// as a live file in the home root. User-edited like a dotfile; edits
// apply at once. It never stops Hal: a missing file means defaults, and
// a malformed file, bad value or unknown key is a warning (host.ts shows
// it to every client) while that setting keeps its default.

import { ason } from '../common/ason.ts'
import type { Event } from '../common/protocol.ts'
import { settings, type Setting } from '../common/settings.ts'
import { strings } from '../common/strings.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { models } from './models.ts'

// The comment config.ason starts with, so whoever opens the file finds
// the readable list of settings (task c0h).
const POINTER = '// Every setting, its default and meaning: /config'

// Loads and watches config.ason; `onChange` hears every edit, external
// or through update. Idempotent.
function init(onChange?: () => void): void {
	if (config.state.data) return
	if (onChange) config.state.onChange = onChange
	let data = liveFiles.liveFile<Record<string, unknown>>(paths.configFile(), {}, { keepBroken: true, onChange: () => config.state.onChange?.() })
	config.state.data = data
	settings.state.raw = data
}

// What is wrong with the file right now, one line each.
function warnings(): string[] {
	let data = config.state.data
	if (!data) return []
	let broken = liveFiles.brokenError(data)
	if (broken) return [`${paths.display(broken.message)}; using the last good settings`]
	return settings.warnings().map((w) => `config.ason: ${w}`)
}

// Apply only changed keys, preserving unknown keys and comments. Defaults
// are represented by absence. Refuse a broken file before mutating it.
function update(values: Record<string, unknown>): string[] {
	config.init()
	let data = config.state.data!
	let broken = liveFiles.brokenError(data)
	if (broken) throw broken
	let changed: string[] = []
	let current = settings.check(data).values
	for (let s of settings.table) {
		if (!(s.name in values) || Object.is(values[s.name], current[s.name])) continue
		let why = settings.problem(s.type, values[s.name])
		if (why) throw new Error(`${s.name}: ${why}`)
		if (s.name === 'model') models.selection(values[s.name] as string)
	}
	for (let s of settings.table) {
		if (!(s.name in values) || Object.is(values[s.name], current[s.name])) continue
		if (s.name.startsWith('cardVerbosity')) delete data[s.name.replace(/^cardVerbosity/, 'blockVerbosity')]
		if (Object.is(values[s.name], s.default)) delete data[s.name]
		else {
			data[s.name] = values[s.name]
			config.explain(data, s)
		}
		changed.push(s.name)
	}
	config.point(data)
	liveFiles.save(data)
	if (changed.length) config.state.onChange?.()
	return changed
}

// Puts the pointer comment on the first key unless some comment already
// has it. Comments ride on keys (ason COMMENTS), so `{}` holds none;
// existing comments are never rewritten, only prefixed.
function point(data: Record<string, unknown>): void {
	let first = Object.keys(data)[0]
	let comments = ((data as any)[ason.COMMENTS] ?? {}) as Record<string, string>
	if (first === undefined || Object.values(comments).some((c) => c.includes(POINTER))) return
	;(data as any)[ason.COMMENTS] = { ...comments, [first]: POINTER + '\n' + (comments[first] ?? '') }
}

// Puts `s`'s description, default and choices on its key, unless the
// key has a comment already: a value /config writes reads like a
// documented line (task hyt).
function explain(data: Record<string, unknown>, s: Setting): void {
	let comments = ((data as any)[ason.COMMENTS] ?? {}) as Record<string, string>
	if (comments[s.name]?.trim()) return
	let text = `${s.description}${s.type.kind === 'choice' ? ` One of: ${s.type.options.join(', ')}.` : ''} Default: ${ason.stringify(s.default, 'short')}.`
	;(data as any)[ason.COMMENTS] = { ...comments, [s.name]: strings.wordWrap(text, 70).map((l) => `// ${l}`).join('\n') }
}

// The /config modal's content (protocol `settings`): every setting's
// effective value as text and what config.ason holds for it.
function event(): Event & { type: 'settings' } {
	config.init()
	let raw = settings.state.raw
	let effective = settings.check(raw).values
	let values: Record<string, string> = {}
	let stored: Record<string, string> = {}
	for (let s of settings.table) {
		values[s.name] = String(effective[s.name])
		if (s.name in raw) stored[s.name] = `${s.name}: ${ason.stringify(raw[s.name], 'short')}`
	}
	return { type: 'settings', values, stored }
}
// Stops watching and forgets the file (tests).
function reset(): void {
	let data = config.state.data
	config.state.data = null
	config.state.onChange = undefined
	settings.state.raw = {}
	if (data) liveFiles.close(data)
}

export const config = {
	state: { data: null as Record<string, unknown> | null, onChange: undefined as (() => void) | undefined },
	init,
	warnings,
	update,
	point,
	explain,
	event,
	reset,
}
