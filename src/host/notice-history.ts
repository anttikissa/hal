// Notification history (task py): every notice and push, newest last,
// kept on the host before delivery in private state/notices.ason so a
// client that was away, reloaded or dismissed a notice can still read
// it. Bounded to limit() entries; ids are stable across reconnects.
import { mkdirSync } from 'fs'
import type { NoticeEntry, NoticeKind } from '../common/notices.ts'
import { forms } from '../common/forms.ts'
import { diag } from './diag.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

type Stored = Omit<NoticeEntry, 'awaiting'> & { question?: string }
type Store = { next: number; entries: Stored[] }

function store(): Store {
	if (noticeHistory.state.store) return noticeHistory.state.store
	mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 })
	let data = liveFiles.liveFile<Store>(`${paths.stateDir()}/notices.ason`, { next: 1, entries: [] }, { watch: false, mode: 0o600 })
	if (!Array.isArray(data.entries) || !Number.isInteger(data.next)) throw new Error('notices.ason: invalid history')
	return (noticeHistory.state.store = data)
}

// Records one event; never stops its delivery.
function record(e: { session: string; name: string; kind: NoticeKind; line: string; what?: string; block?: string; question?: string }): void {
	try {
		let data = store()
		let entry: Stored = { id: `${data.next}`, at: new Date().toISOString(), ...e }
		data.next++
		data.entries = [...data.entries, entry].slice(-noticeHistory.limit())
		liveFiles.save(data)
	} catch (err: any) {
		diag.log(`notice history: ${err?.message ?? err}`)
	}
}

// Newest first; a question entry says whether it still waits for an answer.
function list(): NoticeEntry[] {
	let open = new Map<string, string | undefined>()
	let openId = (session: string) => {
		if (!open.has(session)) {
			try { open.set(session, forms.open(history.readSync(session))?.id) } catch { open.set(session, undefined) }
		}
		return open.get(session)
	}
	return store().entries.toReversed().map(({ question, ...e }) => (question ? { ...e, awaiting: openId(e.session) === question } : e))
}

function reset(): void {
	if (noticeHistory.state.store) liveFiles.close(noticeHistory.state.store)
	noticeHistory.state.store = null
}

export const noticeHistory = {
	state: { store: null as Store | null },
	limit: (): number => 200,
	store, record, list, reset,
}
