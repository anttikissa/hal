import { replay } from './replay.ts'
import type { Message } from './history.ts'

interface HydrateOlderRequest {
	type: 'hydrate-older'
	requestId: string
	sessionId: string
	model?: string
	olderMessages: Message[]
	allMessages: Message[]
	chunkSize: number
}

const scope = globalThis as unknown as {
	onmessage: ((event: any) => void) | null
	postMessage: (value: unknown) => void
}

scope.onmessage = async (event: any) => {
	const req = event?.data as HydrateOlderRequest | undefined
	if (!req || req.type !== 'hydrate-older') return
	const chunkSize = Math.max(1, req.chunkSize)
	try {
		let end = req.olderMessages.length
		while (end > 0) {
			const start = Math.max(0, end - chunkSize)
			const chunk = req.olderMessages.slice(start, end)
			const blocks = await replay.replayToBlocks(req.sessionId, chunk, req.model, true, {
				toolResultSourceMessages: req.allMessages,
				appendInterruptedHint: false,
			})
			scope.postMessage({ type: 'chunk', requestId: req.requestId, blocks })
			end = start
		}
		scope.postMessage({ type: 'done', requestId: req.requestId })
	} catch (error) {
		scope.postMessage({
			type: 'error',
			requestId: req.requestId,
			message: error instanceof Error ? error.message : String(error),
		})
	}
}
