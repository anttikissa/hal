// Google Gemini generateContent protocol (streamGenerateContent?alt=sse),
// for gateways that serve Gemini models only that way (OpenCode Go,
// task 83). Maps a neutral request to its body and its SSE back to
// stream events; credentials and URL belong to the caller.
//
// Gemini returns a thoughtSignature on a part (the first functionCall,
// or the last part). It arrives as a signature event, stored as
// "gemini:<sig>", and goes back on the next functionCall of that message
// (else its last part). A first functionCall without one carries the
// documented skip value, so history from other models stays valid.

import { blocks, type ReplayBlock, type StopReason, type StreamEvent, type Usage } from '../common/blocks.ts'
import { provider, type ProviderRequest, type SseMessage } from './provider.ts'

const PREFIX = 'gemini:'
const SKIP = 'skip_thought_signature_validator'

function image(mediaType: string, data: string | undefined): unknown {
	return data === undefined
		? { text: provider.imageNote('its file is gone') }
		: { inlineData: { mimeType: mediaType, data } }
}

function modelParts(list: ReplayBlock[]): any[] {
	let parts: any[] = []
	let pending: string | undefined
	let signed = false
	for (let b of list) {
		if (b.type === 'thinking') {
			if (b.signature?.startsWith(PREFIX)) pending = b.signature.slice(PREFIX.length)
		} else if (b.type === 'text') {
			if (b.text) parts.push({ text: b.text })
		} else {
			let part: any = { functionCall: { id: b.id, name: b.name, args: b.input } }
			if (pending ?? !signed) part.thoughtSignature = pending ?? SKIP
			pending = undefined
			signed = true
			parts.push(part)
		}
	}
	if (pending && parts.length && !parts.at(-1).thoughtSignature) parts.at(-1).thoughtSignature = pending
	return parts
}

function contents(req: ProviderRequest): unknown[] {
	let out: { role: string; parts: unknown[] }[] = []
	let names = new Map<string, string>()
	for (let m of req.messages) {
		if (m.role === 'assistant') {
			for (let b of m.blocks) if (b.type === 'tool_call') names.set(b.id, b.name)
			let parts = modelParts(m.blocks)
			if (parts.length) out.push({ role: 'model', parts })
			continue
		}
		let parts: unknown[] = []
		let images: unknown[] = []
		for (let b of m.blocks) {
			if (b.type === 'text') parts.push({ text: b.text })
			else if (b.type === 'image') parts.push(image(b.mediaType, req.image?.(b.blob)))
			else {
				let output = b.isError ? `Error: ${b.output}` : b.output
				parts.push({ functionResponse: { id: b.id, name: names.get(b.id) ?? '', response: { output } } })
				for (let i of blocks.resultImages(b)) images.push(image(i.mediaType, req.image?.(i.blob)))
			}
		}
		parts.push(...images)
		if (parts.length) out.push({ role: 'user', parts })
	}
	return out
}

function body(req: ProviderRequest): Record<string, unknown> {
	let b: Record<string, unknown> = {
		contents: gemini.contents(req),
		generationConfig: {
			thinkingConfig: { includeThoughts: true },
			...(req.maxTokens && { maxOutputTokens: req.maxTokens }),
		},
	}
	if (req.system) b.systemInstruction = { parts: [{ text: req.system }] }
	if (req.tools?.length)
		b.tools = [
			{
				functionDeclarations: req.tools.map((t) => ({
					name: t.name,
					description: t.description,
					parametersJsonSchema: t.inputSchema,
				})),
			},
		]
	return b
}

const reasons: Record<string, StopReason> = {
	STOP: 'end',
	MAX_TOKENS: 'max_tokens',
	SAFETY: 'refusal',
	RECITATION: 'refusal',
	PROHIBITED_CONTENT: 'refusal',
	BLOCKLIST: 'refusal',
	SPII: 'refusal',
	IMAGE_SAFETY: 'refusal',
}

function usage(u: any): Usage {
	let cached = u.cachedContentTokenCount ?? 0
	let out: Usage = {}
	if (typeof u.promptTokenCount === 'number') out.input = Math.max(0, u.promptTokenCount - cached)
	out.output = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)
	if (cached) out.cacheRead = cached
	return out
}

// usageMetadata repeats, growing, in every chunk: the last one counts.
// The stream has no end marker, so done follows the last chunk.
async function* parse(messages: AsyncIterable<SseMessage>): AsyncGenerator<StreamEvent> {
	let reason: string | undefined
	let called = 0
	let last: unknown
	for await (let m of messages) {
		let chunk = JSON.parse(m.data)
		if (chunk.error) {
			yield { type: 'error', message: chunk.error.message ?? 'Unknown error', body: m.data }
			return
		}
		let candidate = chunk.candidates?.[0]
		for (let part of candidate?.content?.parts ?? []) {
			if (part.thought && part.text) yield { type: 'thinking', text: part.text }
			else if (part.text) yield { type: 'text', text: part.text }
			if (part.thoughtSignature) yield { type: 'signature', value: PREFIX + part.thoughtSignature }
			if (part.functionCall) {
				let call = part.functionCall
				yield { type: 'tool_call', id: call.id || `call_${called}`, name: call.name, input: call.args ?? {} }
				called++
			}
		}
		if (candidate?.finishReason) reason = candidate.finishReason
		if (chunk.usageMetadata) last = chunk.usageMetadata
		let blocked = chunk.promptFeedback?.blockReason
		if (blocked) {
			yield { type: 'error', message: `Prompt blocked: ${blocked}`, body: m.data }
			return
		}
	}
	if (last) yield { type: 'usage', usage: usage(last) }
	if (!reason) return
	let stop = called && reason === 'STOP' ? 'tool_use' : reasons[reason]
	if (stop) yield { type: 'done', reason: stop }
	else yield { type: 'error', message: `Gemini stopped: ${reason}` }
}

export const gemini = { contents, body, parse }
