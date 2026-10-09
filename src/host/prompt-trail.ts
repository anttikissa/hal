// Task ar: a change to a system-prompt file leaves a trail in the
// session: an output record with a short diff, shown in the transcript
// and handed to the model as a notice on its next request. Without it the model sees new rules and its
// own earlier replies that ignored them, and blames itself.
// The last seen texts live in the session's prompt-files.json.

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { relative } from 'path'
import type { PromptChange } from '../common/prompt-changes.ts'
import { diag } from './diag.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { plugins } from './plugins.ts'
import { systemPrompt } from './system-prompt.ts'

type Seen = { cwd: string; files: Record<string, string> }

const maxLines = 40

function read(path: string): string | undefined {
	try { return readFileSync(path, 'utf8') } catch { return undefined }
}

// Keep the generator off the startup import graph.
function diff(before: string, after: string, limit = maxLines): string {
	return (require('./text-diff.ts') as typeof import('./text-diff.ts')).textDiff.text(before, after, limit)
}

// What plugins put into the prompt (and take out, marked), as a file
// named plugins/; undefined when they change nothing.
const PLUGINS = 'plugins/'
function pluginText(input: Parameters<typeof systemPrompt.inspect>[0], text: string): string | undefined {
	let original = plugins.state.patches.get(systemPrompt)?.get('assemble')?.original
	if (!original) return undefined
	let base: string[] = original.call(systemPrompt, input, []).split('\n'), mine = text.split('\n')
	let had = new Set(base), has = new Set(mine)
	let out = [...mine.filter((l) => !had.has(l)), ...base.filter((l) => !has.has(l)).map((l) => `removed: ${l}`)].join('\n')
	return out ? `${out}\n` : undefined
}

// Compares the session's prompt files with what it last saw; records
// and shows each change. The first look only remembers. Files that
// come or go with a cwd change are not reported: the cwd note covers it.
function check(id: string): void {
	try {
		let meta = sessions.open(id)
		let file = `${paths.sessionDir(id)}/prompt-files.json`
		let input = { cwd: meta.cwd, model: meta.model ?? '', now: Date.now(), sessionId: id }
		let prompt = systemPrompt.inspect(input)
		let now: Seen = { cwd: meta.cwd, files: Object.fromEntries(prompt.sources.map((s) => [s.path, read(s.path) ?? ''])) }
		let extra = pluginText(input, prompt.text)
		if (extra) now.files[PLUGINS] = extra
		let seen: Seen | undefined = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
		if (seen && JSON.stringify(seen) === JSON.stringify(now)) return
		let notes: { text: string; change: PromptChange }[] = []
		if (seen) {
			let sameCwd = seen.cwd === now.cwd
			for (let path of new Set([...Object.keys(seen.files), ...Object.keys(now.files)])) {
				let a = seen.files[path], b = now.files[path]
				if (a === b || ((a === undefined || b === undefined) && !sameCwd)) continue
				let rel = path === PLUGINS ? path : relative(meta.cwd, path)
				let change: PromptChange = { name: rel.startsWith('..') ? paths.display(path) : rel, what: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed', diff: diff(a ?? '', b ?? '') }
				notes.push({ change, text: `${paths.display(path)} ${change.what === 'changed' ? 'changed' : change.what === 'added' ? 'is now part of the system prompt' : 'is no longer part of the system prompt'}:\n${change.diff}` })
			}
		}
		writeFileSync(file, JSON.stringify(now))
		for (let { text, change } of notes) {
			let { n, ts } = history.append(id, { type: 'output', text, change })
			host.broadcast(id, { type: 'output', sessionId: id, text, change, n, ts })
		}
	} catch (e: any) {
		diag.log(`prompt trail: ${id}: ${e?.message ?? e}`)
	}
}

export const promptTrail = { check, diff }
