// Shared setup for the history tests: a fresh home per test, quiet
// logs and naming, scripted provider streams and record helpers.
import { afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import type { DoneEvent, ErrorEvent, Message, StreamEvent } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { diag } from './diag.ts'
import { history } from './history.ts'
import { pages } from './pages.ts'
import { liveFiles } from './live-file.ts'
import { provider } from './provider.ts'
import { sessions } from './sessions.ts'
import { naming } from './naming.ts'
import { paths } from './paths.ts'

const savedHome = paths.state.home
const origOnError = liveFiles.onError
const origStream = provider.stream
const origLog = diag.log
const origPrepare = naming.prepare
let home = ''
// What diag.log said during the current test.
export const logged: string[] = []

export function testHome(): string {
	return home
}

export function useHistory(): void {
	beforeEach(() => {
		home = mkdtempSync(`${tmpdir()}/hal-history-`)
		paths.state.home = home
		liveFiles.onError = () => {}
		// History contracts are independent of title reminder scheduling.
		naming.prepare = () => {}
		logged.length = 0
		diag.log = (m) => void logged.push(m)
	})

	afterEach(() => {
		sessions.closeAll()
		history.state.running.clear()
		history.state.cache.clear()
		history.state.next.clear()
		pages.reset()
		provider.stream = origStream
		naming.prepare = origPrepare
		diag.log = origLog
		liveFiles.onError = origOnError
		if (savedHome === undefined) paths.state.home = undefined
		else paths.state.home = savedHome
		rmSync(home, { recursive: true, force: true })
	})
}

export async function* events(...list: StreamEvent[]): AsyncGenerator<StreamEvent> {
	for (let e of list) yield e
}

export async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
	let out: T[] = []
	for await (let x of it) out.push(x)
	return out
}

// One recorded round ended as a whole turn, however the consumer stops.
export async function* ended(id: string, stream: AsyncIterable<StreamEvent>): AsyncGenerator<StreamEvent> {
	let last: DoneEvent | ErrorEvent | undefined
	try {
		for await (let e of history.record(id, 'fake', stream)) {
			if (e.type === 'done' || e.type === 'error') last = e
			yield e
		}
	} finally {
		history.end(id, last)
	}
}

export const strip = (records: HistoryRecord[]) => records.map(({ ts: _ts, n: _n, ...rest }) => rest)
export const newSession = () => sessions.create({ cwd: '/', model: 'fake/m', name: 'History fixture' }).id

// Lets a test see what a turn sent and script what comes back.
export function fakeStream(script: (input: { messages: Message[] }) => StreamEvent[]) {
	let sent: Message[][] = []
	provider.stream = async function* (_model, input) {
		sent.push(structuredClone(input.messages))
		yield* script(input)
	}
	return sent
}

// A fresh process: nothing of the session's numbers in memory.
export function forget() {
	history.state.next.clear()
	history.state.cache.clear()
	pages.reset()
}
