// Parses models.dev's answer off the host's thread (task 7j): api.json
// is ~5 MB, and parsing, picking and caching it took ~100 ms there.
// Runs modelsDev.parse as defined in models-dev.ts: local.ts and
// plugin overrides of it do not reach this thread.
import { renameSync, writeFileSync } from 'fs'
import { modelsDev } from './models-dev.ts'

export type Job = { body: ArrayBuffer; file: string; tmp: string }
// The catalog as cached (JSON), or why it was refused.
export type Reply = { json: string } | { error: string }

// Picks what Hal uses and replaces the cache atomically: a crash
// leaves the old one.
function handle({ body, file, tmp }: Job): Reply {
	try {
		let next = modelsDev.parse(JSON.parse(new TextDecoder().decode(body)))
		if (!Object.keys(next).length) throw new Error('no providers in the answer')
		let json = modelsDev.serialize(next)
		writeFileSync(tmp, json, { mode: 0o600 })
		renameSync(tmp, file)
		return { json }
	} catch (e: any) {
		return { error: e?.message ?? String(e) }
	}
}

// Runs `job` in a fresh worker; it exits when done.
function run(job: Job): Promise<Reply> {
	return new Promise((resolve, reject) => {
		let w = new Worker(new URL('./models-dev-worker.ts', import.meta.url).href)
		w.onmessage = (e) => (resolve(e.data), w.terminate())
		w.onerror = (e) => (reject(new Error(e.message)), w.terminate())
		w.postMessage(job, [job.body])
	})
}

if (!Bun.isMainThread) self.onmessage = (e: MessageEvent<Job>) => postMessage(modelsDevWorker.handle(e.data))

export const modelsDevWorker = { handle, run }
