// Ranks Find evidence so a query answers "which tab did this?": each hit
// is labeled with its evidence, and hits fold into one row per tab before
// the result limit (task yhm). Runs in the find worker.
import { homedir } from 'os'
import { findQuery, type FindQuery, type FindResult } from '../common/find.ts'
import type { FindRow } from './find-index.ts'
import type { SessionMeta } from './sessions.ts'

type Tab = { best: FindResult; count: number; strong: Set<string>; strongCount: number; age: number }

// /rename commands and their replies name a tab's former titles.
function renamed(text: string): boolean {
	return /^(\/rename[ :]|Session renamed: )/.test(text)
}

// The evidence a matching row gives, as its why label.
function why(row: FindRow, q: FindQuery): string {
	let matches = (text: string) => !!findQuery.match(text, q.words, q.phrases)
	switch (row.kind) {
		case 'metadata':
			return 'title'
		case 'commit':
			// A copied commit notice is not authorship.
			if (row.text.includes('this session did not change')) return 'other'
			return matches(row.text.split('\n')[0]!) ? 'commit' : 'files'
		case 'user':
			return matches(row.text.slice(0, 400)) ? 'request' : 'pasted'
		case 'assistant':
			return 'reply'
		case 'thinking':
			return 'reasoning'
		case 'tool-call':
		case 'tool-output':
			return 'tool'
		default:
			return findRank.renamed(row.text) ? 'former title' : 'other'
	}
}

// The sessions an in: scope names, or undefined for every session.
// `here` is the tab Find opened from; `tabs` the open tabs in order.
function scope(
	q: FindQuery,
	here: string | undefined,
	tabs: string[],
	meta: Map<string, SessionMeta>,
): Set<string> | undefined {
	if (!q.scope.length) return undefined
	let ids = new Set<string>()
	let current = () => {
		if (!here || !meta.has(here)) throw new Error('in:here and in:. need the tab Find was opened from')
		return here
	}
	for (let v of q.scope) {
		let range = /^(\d+)(?:-(\d+))?$/.exec(v)
		if (v.toLowerCase() === 'here') ids.add(current())
		else if (/^\d+-[a-z]{3}$/i.test(v)) {
			if (!meta.has(v.toLowerCase())) throw new Error(`in: no session ${v}`)
			ids.add(v.toLowerCase())
		} else if (range) {
			let from = Number(range[1]),
				to = Number(range[2] ?? range[1])
			let found = tabs.slice(Math.min(from, to) - 1, Math.max(from, to))
			if (!found.length) throw new Error(`in: no tab ${v}`)
			for (let id of found) ids.add(id)
		} else {
			let dir = v === '.' ? meta.get(current())!.cwd : v.replace(/^~(?=\/|$)/, homedir())
			dir = dir.replace(/\/+$/, '') || '/'
			for (let m of meta.values()) if (m.cwd === dir || m.cwd.startsWith(dir === '/' ? '/' : dir + '/')) ids.add(m.id)
		}
	}
	return ids
}

// Score order: relevance first; recency breaks ties between scores that
// round alike.
function order(a: FindResult, b: FindResult): number {
	return Math.round(b.score) - Math.round(a.score) || a.age - b.age || a.href.localeCompare(b.href)
}

// One row per tab: its best evidence, the number of matching cards, and
// a bonus for each kind of strong evidence and for their count.
function group(): { add(h: FindResult): void; top(n: number): FindResult[] } {
	let tabs = new Map<string, Tab>()
	return {
		add(h) {
			let t = tabs.get(h.sessionId)
			if (!t) tabs.set(h.sessionId, (t = { best: h, count: 0, strong: new Set(), strongCount: 0, age: h.age }))
			t.count++
			t.age = Math.min(t.age, h.age)
			if (findQuery.strong.includes(h.why)) {
				t.strong.add(h.why)
				if (h.why === 'commit' || h.why === 'request') t.strongCount++
			}
			if (h.score > t.best.score) t.best = h
		},
		top(n) {
			return [...tabs.values()]
				.map((t) => ({
					...t.best,
					count: t.count,
					age: t.age,
					score: t.best.score + 10 * t.strong.size + Math.min(5, Math.log2(1 + t.strongCount)),
				}))
				.sort(findRank.order)
				.slice(0, n)
		},
	}
}

export const findRank = { renamed, why, scope, order, group }
