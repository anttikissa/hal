// Commit notices (task hy): commits a bash call makes pop up in other
// tabs. Rides on file-changes.ts: begin gets the HEAD reflog path from
// its rev-parse call and notes the size; finish reads only complete
// lines appended since. Reading the reflog takes no lock.
// A commit names a session only through its Session trailer (task pdw),
// cross-checked against that session's own calls; never by timing.

import { existsSync } from 'fs'
import { basename } from 'path'
import type { HistoryRecord } from '../common/replay.ts'
import { open, stat } from 'fs/promises'
import type { NoticeEvent } from '../common/notices.ts'
import { diag } from './diag.ts'
import { fileChanges } from './file-changes.ts'
import { history } from './history.ts'
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

// The session a Session trailer names, if it is one of this home; else none.
function attribute(trailer: string): string | undefined {
	if (/^[\w-]+$/.test(trailer) && existsSync(`${paths.sessionDir(trailer)}/session.ason`)) return trailer
}

// Whether `records` (the claimed session's history) back its claim to
// the commit `short` made at `time` (unix seconds; the reflog's whole
// seconds, so the second after counts too): 'yes' when a bash call
// running then has "commit" in its command, or a tool result from then
// on prints the hash; 'wait' while a call running then has no result.
function check(records: HistoryRecord[], short: string, time: number): 'yes' | 'no' | 'wait' {
	let from = time * 1000, to = from + 1000
	let calls = new Map<string, { command: string; start: number; end?: number }>()
	let printed = false
	for (let r of records) {
		if (r.type === 'assistant' && r.block.type === 'tool_call' && r.block.name === 'bash') calls.set(r.block.id, { command: String((r.block.input as any)?.command ?? ''), start: Date.parse(r.ts) })
		if (r.type !== 'user') continue
		for (let b of r.blocks) {
			if (b.type !== 'tool_result') continue
			let call = calls.get(b.id)
			if (call) call.end = Date.parse(r.ts)
			let out = typeof b.output === 'string' ? b.output : (b.output as any)?.text ?? ''
			if (Date.parse(r.ts) >= from && out.includes(short)) printed = true
		}
	}
	let running = [...calls.values()].filter((c) => c.start < to && (c.end === undefined || c.end >= from))
	if (printed || running.some((c) => c.command.includes('commit'))) return 'yes'
	return running.some((c) => c.end === undefined) ? 'wait' : 'no'
}

// Checks the claim now, or again on each of the session's appends while
// a call running at commit time has no result; warns when it fails.
// Advisory: trailers and command text are not proof.
function verify(id: string, short: string, subject: string, time: number): void {
	let run = () => {
		let verdict = commits.check(history.readSync(id), short, time)
		if (verdict !== 'wait') { stop(); if (verdict === 'no') commits.warn(id, short, subject) }
	}
	let stop = history.onAppend((sid, r) => { if (sid === id && r.type === 'user') run() })
	run()
}

// A persistent warning: in the notice history and the claimed session.
function warn(id: string, short: string, subject: string): void {
	let line = `Commit ${short} says Session: ${id}, but no call in ${id} made it: none running at commit time had "commit" in its command, and no result from then on printed ${short}. (${subject})`
	noticeHistory.record({ session: id, name: sessions.open(id).name ?? id, kind: 'warning', line })
	let { n, ts } = history.append(id, { type: 'output', text: line, error: true })
	host.broadcast(id, { type: 'output', sessionId: id, text: line, error: true, n, ts })
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
			if (!c) continue
			let id = commits.attribute(c.trailer)
			commits.announce(id, e.hash, c.short, c.subject, e.amend, basename(watch.cwd))
			if (id) commits.verify(id, c.short, c.subject, e.time)
		}
	} catch (e: any) {
		diag.log(`commit notices: ${e?.message ?? e}`)
	}
}

// Every client except those watching the session (they see it in its
// transcript); never a push. Without a session (`id` empty) the notice
// names the repository directory `repo` instead.
function announce(id: string | undefined, hash: string, short: string, subject: string, amend = false, repo = ''): void {
	let notice: NoticeEvent = { type: 'notice', session: id ?? '', name: id ? sessions.open(id).name ?? id : repo, kind: 'commit', line: `${short} ${subject}`, key: `commit:${hash}` }
	if (amend) notice.what = 'amended'
	noticeHistory.record({ session: id ?? '', name: notice.name, kind: 'commit', line: notice.line, ...(amend ? { what: 'amended' } : {}) })
	let list = tabs.list()
	let tab = id ? list.findIndex((t) => t.id === id) : -1
	if (tab >= 0) notice.tab = tab + 1
	if (list[tab]?.color !== undefined) notice.color = list[tab]!.color
	for (let c of host.state.clients) if (c.visible !== id) c.deliver(notice)
}

export const commits = {
	state: { seen: [] as string[] },
	remember: 500,
	begin, parse, appended, trailer, attribute, check, verify, warn, finish, announce,
}
