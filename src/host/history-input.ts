// Provider input rebuilt from a session's history: its messages for the
// next request, and a single-round model turn recorded back into it.
import { blocks, type DoneEvent, type ErrorEvent, type StreamEvent, type ThinkingBlock } from '../common/blocks.ts'
import { modelNotices } from '../common/model-notices.ts'
import { replay } from '../common/replay.ts'
import { cacheMarker } from '../common/cache-marker.ts'
import { tokenEstimates } from '../common/token-estimates.ts'
import { blobs } from './blobs.ts'
import { config } from './config.ts'
import { history } from './history.ts'
import { imageFit } from './image-fit.ts'
import { models } from './models.ts'
import { neighbors } from './neighbors.ts'
import { promptCache } from './prompt-cache.ts'
import { provider, type ProviderRequest } from './provider.ts'
import { pruning } from './pruning.ts'
import { sessions } from './sessions.ts'
import { decisions } from './decisions.ts'
import { pages } from './pages.ts'

// The session as provider messages, each prompt's paste markers
// expanded to the pasted text (blobs.expand): history keeps markers.
async function messages(id: string, budget: { overhead?: number; window?: number; model?: string } = {}) {
	if (budget.model && decisions.is(budget.model)) {
		let offset = pages.marks(id).prompt
		let r = offset === undefined ? undefined : pages.lineAt(history.file(id), offset).record
		if (r?.type !== 'user') throw new Error('Missing current decision input')
		return [
			{
				role: 'user' as const,
				blocks: r.blocks.map((b) => (b.type === 'text' ? { ...b, text: blobs.expand(id, b.text) } : b)),
			},
		]
	}
	for (let text of neighbors.notes(id, sessions.open(id).cwd)) history.append(id, { type: 'notice', text })
	let settingsNote = config.told(id)
	if (settingsNote) history.append(id, { type: 'notice', text: settingsNote })
	// A thinking block as the provider sent it: its signature back from its blob.
	let signed = ({ signatureBlob, ...b }: ThinkingBlock): ThinkingBlock => ({
		...b,
		signature: blobs.text(id, signatureBlob!),
	})
	let records = pruning.project(
		id,
		history.context(id),
		budget,
		(r) =>
			r.type === 'user'
				? {
						...r,
						blocks: r.blocks.map((b) =>
							b.type === 'text' && /\[(?:paste|file)[/ ]/.test(b.text) ? { ...b, text: blobs.expand(id, b.text) } : b,
						),
					}
				: r.type === 'assistant' && r.block.type === 'thinking' && r.block.signatureBlob !== undefined
					? { ...r, block: signed(r.block) }
					: r,
		(current) => promptCache.project(id, current),
	)
	let due = modelNotices.pending(replay.current(records))
	let byNumber = new Map(records.map((r) => [r.n, r]))
	for (let notice of due)
		if (byNumber.get(notice.source)?.type !== 'notice')
			records.push(history.append(id, { type: 'notice', text: notice.text, rendered: true, source: notice.source }))
	due = modelNotices.pending(replay.current(records))
	if (due.length) records.push(history.append(id, { type: 'user', blocks: [], notices: due }))
	return cacheMarker.markCache(records, replay.toMessages(records), budget.model)
}

// One single-round model turn for an open session, from its history
// and model, ended however the consumer stops. Tool calls are left
// unanswered; the host's turns run them (host.ts).
async function* turn(
	id: string,
	opts: Omit<ProviderRequest, 'model' | 'messages'> = {},
	signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
	let modelId = sessions.open(id).model
	let overhead = (opts.system?.length ?? 0) + JSON.stringify(opts.tools ?? []).length
	let messages = await historyInput.messages(id, {
		overhead,
		window: models.contextWindow(modelId),
		model: modelId,
	})
	let byteLimit = pruning.maxBytes(modelId)
	let fit = pruning.estimateBytes(id, messages, overhead, modelId) > byteLimit
	let cap = fit ? imageFit.perImageCap(messages, byteLimit, tokenEstimates.characters(messages, overhead)) : undefined
	let input = {
		...opts,
		messages,
		image: (blob: string, maxEdge?: number, imageOpts?: Parameters<typeof blobs.image>[3]) =>
			blobs.image(id, blob, maxEdge, {
				...imageOpts,
				...(fit && { fit: true, maxBytes: imageOpts?.maxBytes ? Math.min(imageOpts.maxBytes, cap!) : cap }),
			}),
	}
	let providerName = blocks.parseModelId(modelId)?.provider ?? modelId
	let last: DoneEvent | ErrorEvent | undefined
	try {
		for await (let event of history.record(
			id,
			providerName,
			provider.stream(modelId, input, signal),
			{ model: modelId },
			signal,
		)) {
			if (event.type === 'done' || event.type === 'error') last = event
			yield event
		}
	} finally {
		history.end(id, last)
	}
}

export const historyInput = { messages, turn }
