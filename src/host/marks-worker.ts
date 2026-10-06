// Off the host's thread (task 7j): work on one session's marks whose
// cost grows with data the host cannot slice, a single ASON value.
// `upgrade`: marks.ason from before `files` kept every changed path (up
// to 15 MB, ~800 ms to load); it is converted and replaced atomically.
// `paths`: the distinct paths of the file_changes records at `offsets`
// (one record can be 25 MB).
import { existsSync, renameSync, readFileSync, statSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { ason } from '../common/ason.ts'
import { changedFiles } from './changed-files.ts'
import { pages } from './pages.ts'

export type Job = { upgrade: string } | { history: string; offsets: number[] }
export type Reply = { paths?: string[]; error?: string }

function handle(job: Job): Reply {
	try {
		if ('history' in job) {
			let seen = new Set<string>()
			for (let o of job.offsets) changedFiles.add(seen, pages.lineAt(job.history, o).record)
			return { paths: [...seen] }
		}
		let m = ason.parse(readFileSync(job.upgrade, 'utf8')) as Record<string, unknown>
		if (!m || typeof m !== 'object' || !('changedPaths' in m)) return {}
		changedFiles.upgrade(m)
		let tmp = `${job.upgrade}.tmp.${process.pid}.w`
		writeFileSync(tmp, ason.stringify(m) + '\n')
		renameSync(tmp, job.upgrade)
		return {}
	} catch (e: any) {
		return { error: e?.message ?? String(e) }
	}
}

// Runs `job` in a fresh worker; it exits when done.
function run(job: Job): Promise<Reply> {
	return new Promise((resolve, reject) => {
		let w = new Worker(new URL('./marks-worker.ts', import.meta.url).href)
		w.onmessage = (e) => (resolve(e.data), w.terminate())
		w.onerror = (e) => (reject(new Error(e.message)), w.terminate())
		w.postMessage(job)
	})
}

// Converts the old marks of `ids` not loaded yet in a worker, so first
// loading them never blocks: undefined when none is over bigMarks bytes,
// else a promise that resolves once done. A failure leaves the file to
// pages.load().
function upgrade(ids: string[]): Promise<void> | undefined {
	let big = ids.map((id) => pages.marksPath(id)).filter((path) => !pages.state.marks.has(path) && existsSync(path) && statSync(path).size > marksWorker.bigMarks)
	if (!big.length) return undefined
	return Promise.all(
		big.map(async (path) => {
			if (!(await readFile(path, 'utf8').catch(() => '')).includes('changedPaths') || pages.state.marks.has(path)) return
			await marksWorker.run({ upgrade: path }).catch(() => {})
		}),
	).then(() => {})
}

if (!Bun.isMainThread) self.onmessage = (e: MessageEvent<Job>) => postMessage(marksWorker.handle(e.data))

export const marksWorker = {
	// Old marks bigger than this convert in a worker (upgrade).
	bigMarks: 64 * 1024,
	handle,
	run,
	upgrade,
}
