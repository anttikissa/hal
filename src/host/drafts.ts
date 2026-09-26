// Each session's draft (tasks/j1/states.md, Drafts and sending): the
// text typed but not sent, one per session, in sessions/<id>/draft.ason
// so it outlives the host. Every client edits the same draft; `rev`
// counts changes, and an edit based on an older rev than the current
// one keeps both texts, so two clients typing apart never lose either.

import type { Draft } from '../common/protocol.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

function file(id: string): string {
	return `${paths.sessionDir(id)}/draft.ason`
}

function load(id: string): Draft {
	let data = drafts.state.files.get(id)
	if (!data) {
		data = liveFiles.liveFile<Draft>(drafts.file(id), { text: '', rev: 0 }, { watch: false })
		drafts.state.files.set(id, data)
	}
	return data
}

function get(id: string): Draft {
	let d = drafts.load(id)
	return { text: d.text, rev: d.rev }
}

// What the draft becomes when `text` arrives edited from `base` while
// the draft is `current`.
function merge(current: Draft, text: string, base?: number): string {
	if (base === undefined || base === current.rev || !current.text.trim()) return text
	if (text.includes(current.text)) return text
	if (current.text.includes(text)) return current.text
	return `${current.text}\n\n${text}`
}

// Sets the draft, on disk before returning. Undefined if unchanged.
function set(id: string, text: string, base?: number): Draft | undefined {
	let d = drafts.load(id)
	let next = drafts.merge(d, text, base)
	if (next === d.text) return undefined
	d.text = next
	d.rev++
	liveFiles.save(d)
	return drafts.get(id)
}

// After a submit of `text`: the draft it was typed in is sent, so it
// clears, unless it holds more than was sent (another client typed on).
function sent(id: string, text: string): Draft | undefined {
	let current = drafts.get(id).text.trim()
	return current && text.includes(current) ? drafts.set(id, '') : undefined
}

function reset(): void {
	for (let data of drafts.state.files.values()) liveFiles.close(data)
	drafts.state.files.clear()
}

export const drafts = {
	state: { files: new Map<string, Draft>() },
	file,
	load,
	get,
	merge,
	set,
	sent,
	reset,
}
