// USER.md in the Hal home: a short private Markdown briefing about the
// user (task ky). A few optional field lines, not a schema: everything
// else in it is the user's and stays byte for byte.
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs'
import { clients } from './clients.ts'
import { paths } from './paths.ts'

export type Fields = { Name?: string; 'Language preference'?: string; Timezone?: string }
const labels = ['Name', 'Language preference', 'Timezone'] as const

function file(): string {
	return `${paths.home()}/USER.md`
}

function text(): string {
	return existsSync(profile.file()) ? readFileSync(profile.file(), 'utf8') : ''
}

// A usable one-line value: blank, placeholders and "unknown" are none.
function value(raw: string | undefined): string | undefined {
	let v = raw?.trim().replace(/[\r\n]+/g, ' ')
	return v && !/<[^>]*>/.test(v) && !/^(?:not specified|unknown|n\/a|unspecified)$/i.test(v) ? v : undefined
}

function field(text: string, label: string): string | undefined {
	return [...text.matchAll(new RegExp(`^${label}:[ \t]*(.*)$`, 'gmi'))]
		.map((m) => profile.value(m[1])).findLast((v) => v !== undefined)
}

// A stored timezone is an IANA name, never a numeric offset.
function timezone(v: string): boolean {
	return clients.zone(v) !== undefined
}

// Writes the given fields: each replaces its first line in place (later
// duplicates go), a missing one goes after the last field line, else
// after the # User header, else at the end. Nothing else changes. A new
// file starts with the header; writes are atomic and 0600.
function save(fields: Fields): void {
	let given = labels.filter((l) => profile.value(fields[l]) !== undefined)
	if (!given.length) return
	let lines = (profile.text() || '# User\n').split('\n')
	let at = (label: string) => lines.findIndex((l) => new RegExp(`^${label}:`, 'i').test(l))
	for (let label of given) {
		let line = `${label}: ${profile.value(fields[label])}`
		let i = at(label)
		if (i >= 0) {
			lines[i] = line
			for (let j = lines.length - 1; j > i; j--) if (new RegExp(`^${label}:`, 'i').test(lines[j]!)) lines.splice(j, 1)
			continue
		}
		let anchor = Math.max(...labels.map(at))
		if (anchor < 0) anchor = lines.findIndex((l) => /^# User\b/i.test(l))
		if (anchor < 0) {
			if (lines.at(-1) !== '') lines.push('')
			lines.push(line, '')
			continue
		}
		let next = lines[anchor + 1]
		lines.splice(anchor + 1, 0, '', line, ...(next ? [''] : []))
	}
	let path = existsSync(profile.file()) ? realpathSync(profile.file()) : profile.file()
	writeFileSync(`${path}.tmp`, lines.join('\n'), { mode: 0o600 })
	renameSync(`${path}.tmp`, path)
}

export const profile = { file, text, value, field, timezone, save }
