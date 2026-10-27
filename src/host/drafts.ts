// Each session's draft (tasks/j1/states.md, Drafts and sending): the
// text typed but not sent, one per session, in sessions/<id>/draft.ason
// so it outlives the host. Every client edits the same draft; `rev`
// counts changes, and an edit based on an older rev than the current
// one keeps both texts, so two clients typing apart never lose either.

import type { Draft } from '../common/snapshot.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

// `by`: the client whose edits made the latest revs, all since rev `since`.
type Stored = Draft & { by?: string; since?: number }

function file(id: string): string {
	return `${paths.sessionDir(id)}/draft.ason`
}

function load(id: string): Stored {
	let data = drafts.state.files.get(id)
	if (!data) {
		data = liveFiles.liveFile<Stored>(drafts.file(id), { text: '', rev: 0 }, { watch: false })
		drafts.state.files.set(id, data)
	}
	return data
}

function get(id: string): Draft {
	let d = drafts.load(id)
	return { text: d.text, rev: d.rev }
}

// The client a command came from: ids are `<client>.<n>` (connection.nextId).
function sender(command?: string): string | undefined {
	return command?.match(/^(.+)\.\d+$/)?.[1]
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
function set(id: string, text: string, base?: number, command?: string): Draft | undefined {
	let d = drafts.load(id)
	let next = drafts.merge(d, text, base)
	if (next === d.text) return undefined
	let by = drafts.sender(command)
	if (!by) {
		delete d.by
		delete d.since
	} else if (by !== d.by) {
		d.by = by
		d.since = d.rev
	}
	d.text = next
	d.rev++
	liveFiles.save(d)
	return drafts.get(id)
}

// After a submit of `text`: the draft it was typed in is sent, so it
// clears, unless it holds more than was sent (another client typed on).
// `base`, the rev the sender's draft was typed from: if only the sender
// changed the draft since, it clears even when the host missed the last
// edits or got them late, after a reconnect.
function sent(id: string, text: string, base?: number, command?: string): Draft | undefined {
	let d = drafts.load(id),
		current = d.text.trim(),
		by = drafts.sender(command)
	let own = base !== undefined && (base === d.rev || (!!by && by === d.by && base >= d.since!))
	return current && (own || text.includes(current)) ? drafts.set(id, '') : undefined
}

function reset(): void {
	for (let data of drafts.state.files.values()) liveFiles.close(data)
	drafts.state.files.clear()
}

export const drafts = {
	state: { files: new Map<string, Stored>() },
	file,
	load,
	get,
	sender,
	merge,
	set,
	sent,
	reset,
}
