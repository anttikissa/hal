// Links to blocks (task 0z): every card has the address
// /<session id>#<block id>, the block id being its item's key (task
// w5), the same in every client, after a reload and in a page of
// earlier history; a kind letter may lead it (#t19, task 9p). Opening such an address scrolls to that card, marks
// it and opens it (a tool card with its whole output), loading earlier
// pages until the block shows. Addresses are relative to the page until
// the host's webUrl reaches the browser (task e3).

import { transcript } from '../common/transcript.ts'
import type { Row } from './view.ts'

// The block the address points at in session `session`.
export type Target = { session: string; key: string }

// The target an address names, if it names a session and a block.
function parse(url: string, session: string | undefined): Target | undefined {
	let key = decodeURIComponent(new URL(url).hash.slice(1))
	return session && transcript.href(session, key) ? { session, key: key.replace(/^[a-z](?=\d)/, '') } : undefined
}

// The row showing block `key`: its own, or a tool result's call.
function row(rows: Row[], key: string): Row | undefined {
	return rows.find((r) => r.item.key === key || r.result?.key === key)
}

// What to do for target `t` given the shown session's rows: show a
// row, fetch an earlier page (`more`: some are left), or give up.
function seek(t: Target, session: string | undefined, rows: Row[], more: boolean, dropped: number[] = []): { row: Row } | 'older' | 'missing' | 'dropped' | 'wait' {
	if (session !== t.session) return 'wait'
	if (dropped.includes(Number(t.key.split('.')[0]))) return 'dropped'
	let hit = target.row(rows, t.key)
	if (hit) return { row: hit }
	return more ? 'older' : 'missing'
}

export const target = { parse, href: (session: string, key: string) => transcript.href(session, key), row, seek }
