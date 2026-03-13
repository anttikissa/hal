// Progressive background hydration — replays older messages in chunks.

import type { Block } from '../cli/blocks.ts'
import type { Message } from './history.ts'
import { replay } from './replay.ts'
import { startupTrace } from '../perf/startup-trace.ts'
import { randomBytes } from 'crypto'

interface HydrationTarget {
	sessionId: string
	blocks: Block[]
	loadingHistory: boolean
	info: { model?: string }
}

export const progressiveHydrateConfig = {
	chunkMessages: 120,
	useWorker: true,
}

const activeHydrations = new Map<string, Promise<void>>()

async function hydrateInProcess(target: HydrationTarget, olderMessages: Message[], allMessages: Message[]): Promise<void> {
	let end = olderMessages.length
	while (end > 0) {
		const chunkSize = Math.max(1, progressiveHydrateConfig.chunkMessages)
		const start = Math.max(0, end - chunkSize)
		const chunk = olderMessages.slice(start, end)
		const chunkBlocks = await replay.replayToBlocks(target.sessionId, chunk, target.info.model, true, {
			toolResultSourceMessages: allMessages,
			appendInterruptedHint: false,
		})
		if (chunkBlocks.length > 0) target.blocks.unshift(...chunkBlocks)
		end = start
		await Bun.sleep(0)
	}
}

async function hydrateInWorker(target: HydrationTarget, olderMessages: Message[], allMessages: Message[]): Promise<void> {
	const worker = new Worker(new URL('./replay-worker.ts', import.meta.url).href, { type: 'module' })
	const requestId = randomBytes(8).toString('hex')
	try {
		await new Promise<void>((resolve, reject) => {
			let done = false
			const finish = (fn: () => void) => {
				if (done) return
				done = true
				fn()
			}
			worker.onmessage = (event: any) => {
				const msg = event?.data as any
				if (!msg || msg.requestId !== requestId) return
				if (msg.type === 'chunk') {
					const chunkBlocks = Array.isArray(msg.blocks) ? msg.blocks : []
					if (chunkBlocks.length > 0) target.blocks.unshift(...chunkBlocks)
					return
				}
				if (msg.type === 'done') {
					finish(resolve)
					return
				}
				if (msg.type === 'error') {
					finish(() => reject(new Error(typeof msg.message === 'string' ? msg.message : 'history worker failed')))
				}
			}
			worker.onerror = (event: any) => {
				finish(() => reject(new Error(event?.message || 'history worker failed')))
			}
			worker.postMessage({
				type: 'hydrate-older',
				requestId,
				sessionId: target.sessionId,
				model: target.info.model,
				olderMessages,
				allMessages,
				chunkSize: Math.max(1, progressiveHydrateConfig.chunkMessages),
			})
		})
	} finally {
		worker.terminate()
	}
}

function hydrateInBackground(
	target: HydrationTarget,
	olderMessages: Message[],
	allMessages: Message[],
	opts?: { startupTraceMessageCount?: number; onDone?: () => void },
): void {
	if (olderMessages.length === 0) return
	if (activeHydrations.has(target.sessionId)) return
	target.loadingHistory = true
	const sessionId = target.sessionId
	const task = (async () => {
		if (progressiveHydrateConfig.useWorker && typeof Worker !== 'undefined') {
			try {
				await progressiveHydrate.hydrateInWorker(target, olderMessages, allMessages)
				return
			} catch {}
		}
		await progressiveHydrate.hydrateInProcess(target, olderMessages, allMessages)
	})()
	activeHydrations.set(sessionId, task)
	void task.finally(() => {
		activeHydrations.delete(sessionId)
		target.loadingHistory = false
		if (opts?.startupTraceMessageCount !== undefined) {
			startupTrace.mark('active-all-hydrated', `${opts.startupTraceMessageCount} messages (${target.sessionId})`)
		}
		opts?.onDone?.()
	})
}

export const progressiveHydrate = {
	hydrateInProcess,
	hydrateInWorker,
	hydrateInBackground,
	activeHydrations,
}
