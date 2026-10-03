// Commit notices (task hy): commits a bash call makes pop up in other
// tabs. Rides on file-changes.ts: begin gets the HEAD reflog path from
// its rev-parse call and notes the size; finish reads only complete
// lines appended since. Reading the reflog takes no lock.

import { existsSync } from 'fs'
import { open, stat } from 'fs/promises'
import type { NoticeEvent } from '../common/notices.ts'
import { diag } from './diag.ts'
import { fileChanges } from './file-changes.ts'
import { host } from './host.ts'
import { noticeHistory } from './notice-history.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'

type Watch = { sessionId: string; cwd: string; log: string; size: number; start: number }
type Entry = { hash: string; time: number; amend: boolean }

// A missing reflog before the call counts as empty, so an initial commit shows.
async function begin(sessionId: string, cwd: string, log: string): Promise<Watch> {
	let size = await stat(log).then((s) => s.size, (e) => { if (e.code === 'ENOENT') return 0; throw e })
	let watch = { sessionId, cwd, log, size, start: Date.now() }
	commits.state.active.add(watch)
	return watch
}

// '<old> <new> <ident> <unix-time> <tz>\t<message>': commits made here,
// not pulls, rebases, resets, checkouts or fast-forwards.
function parse(text: string): Entry[] {
	return text.split('\n').flatMap((line) => {
		let m = /^[0-9a-f]+ ([0-9a-f]+) .* (\d+) [+-]\d{4}\t(commit \(amend\)|commit|revert|cherry-pick)/.exec(line)
		return m ? [{ hash: m[1]!, time: Number(m[2]), amend: m[3] === 'commit (amend)' }] : []
	})
}

// Bytes appended since `from`, cut after the last newline; none if the reflog shrank or went.
async function appended(log: string, from: number): Promise<string> {
	let file = await open(log).catch((e) => { if (e.code === 'ENOENT') return undefined; throw e })
	if (!file) return ''
	try {
		let { size } = await file.stat()
		if (size <= from) return ''
		let buf = Buffer.alloc(size - from)
		let { bytesRead } = await file.read(buf, 0, buf.length, from)
		let text = buf.subarray(0, bytesRead).toString('utf8')
		return text.slice(0, text.lastIndexOf('\n') + 1)
	} finally { await file.close() }
}

// The last 'Session: <id>' line. Git's %(trailers) misses this repo's
// trailer block: 'Implemented by' has a space, so git rejects the block.
function trailer(body: string): string {
	return [...body.matchAll(/^Session: *(\S+) *$/gm)].at(-1)?.[1] ?? ''
}

// A Session trailer naming a session of this home wins; else the latest
// call on this reflog that started by the entry's time (whole seconds).
function attribute(watch: Watch, entry: Entry, trailer: string): string {
	if (/^[\w-]+$/.test(trailer) && existsSync(`${paths.sessionDir(trailer)}/session.ason`)) return trailer
	let calls = [...commits.state.active].filter((w) => w.log === watch.log && Math.floor(w.start / 1000) <= entry.time)
	return calls.sort((a, b) => b.start - a.start)[0]?.sessionId ?? watch.sessionId
}

async function finish(watch: Watch): Promise<void> {
	try {
		let fresh = commits.parse(await commits.appended(watch.log, watch.size)).filter((e) => !commits.state.seen.includes(e.hash))
		if (!fresh.length) return
		// Claim before awaiting: concurrent calls read the same lines.
		commits.state.seen = [...commits.state.seen, ...fresh.map((e) => e.hash)].slice(-commits.remember)
		let out = await fileChanges.git(watch.cwd, ['log', '--no-walk=unsorted', '-z', '--format=%H%x1f%h%x1f%s%x1f%B', ...fresh.map((e) => e.hash)])
		if (out.code) throw new Error(out.error)
		let info = new Map(out.text.split('\0').filter(Boolean).map((r) => { let [h, short, subject, body] = r.split('\x1f'); return [h!, { short: short!, subject: subject!, trailer: commits.trailer(body ?? '') }] }))
		for (let e of fresh) {
			let c = info.get(e.hash)
			if (c) commits.announce(commits.attribute(watch, e, c.trailer), e.hash, c.short, c.subject, e.amend)
		}
	} catch (e: any) {
		diag.log(`commit notices: ${e?.message ?? e}`)
	} finally { commits.state.active.delete(watch) }
}

// Every client except those watching the session (they see it in its transcript); never a push.
function announce(id: string, hash: string, short: string, subject: string, amend = false): void {
	let notice: NoticeEvent = { type: 'notice', session: id, name: sessions.open(id).name ?? id, kind: 'commit', line: `${short} ${subject}`, key: `commit:${hash}` }
	if (amend) notice.what = 'amended'
	noticeHistory.record({ session: id, name: notice.name, kind: 'commit', line: notice.line, ...(amend ? { what: 'amended' } : {}) })
	let list = tabs.list()
	let tab = list.findIndex((t) => t.id === id)
	if (tab >= 0) notice.tab = tab + 1
	if (list[tab]?.color !== undefined) notice.color = list[tab]!.color
	for (let c of host.state.clients) if (c.visible !== id) c.deliver(notice)
}

export const commits = {
	state: { active: new Set<Watch>(), seen: [] as string[] },
	remember: 500,
	begin, parse, appended, trailer, attribute, finish, announce,
}
