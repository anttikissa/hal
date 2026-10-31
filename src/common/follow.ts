// Bounds the sessions a client follows (task qrd): following all of
// 1000 tabs floods the socket on every reconnect. A client follows the
// shown tab and the few it may show next; both clients use these rules.

import { connection } from './connection.ts'
import { queueEdit } from './queue-edit.ts'

// The most sessions a client follows, the shown one included.
const limit = 8

// The tabs to follow besides `shown`, most likely next first: `pressed`
// (a tab under the pointer), the neighbors Ctrl-N and Ctrl-P reach, then
// the tabs on screen nearest the shown one.
function wanted(ids: string[], shown: string, onScreen: { start: number; end: number }, pressed?: string): string[] {
	let at = ids.indexOf(shown)
	if (at < 0) return []
	let n = ids.length
	let near = ids
		.slice(onScreen.start, onScreen.end)
		.sort((a, b) => Math.abs(ids.indexOf(a) - at) - Math.abs(ids.indexOf(b) - at))
	let all = [pressed, ids[(at + 1) % n], ids[(at + n - 1) % n], ...near]
	return [...new Set(all)].filter((id): id is string => !!id && id !== shown && ids.includes(id)).slice(0, limit - 1)
}

// A session that must stay followed: closing it would release its queue
// edit, or a command pending for it would find it not open.
function busy(id: string): boolean {
	if (queueEdit.editing(id)) return true
	for (let c of connection.state.pending.values())
		if (c.sessionId === id && c.type !== 'open' && c.type !== 'close') return true
	return false
}

export const follow = { limit, wanted, busy }
