// Provider interface and the shared HTTP/SSE plumbing behind it. A
// provider only maps a neutral request to one HTTP request and parses
// SSE messages back into stream events; fetch, SSE framing, timeouts
// and abort live here once. Wire mappings: tasks/7f/mapping.md.

import { blocks, type ErrorEvent, type Message, type StreamEvent } from '../common/blocks.ts'

export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> }

export type ProviderRequest = {
	// Model name without the "provider/" prefix.
	model: string
	system?: string
	messages: Message[]
	tools?: ToolDef[]
	maxTokens?: number
}

export type HttpRequest = { url: string; headers: Record<string, string>; body: unknown }

// One server-sent event. `data` stays text: not every stream is all
// JSON (Chat Completions ends with "[DONE]").
export type SseMessage = { event: string | undefined; data: string }

export type Provider = {
	// May be async, e.g. to refresh credentials; throwing becomes an error event.
	request(req: ProviderRequest): HttpRequest | Promise<HttpRequest>
	// Should end with done or error; shared code adds an error if not.
	parse(messages: AsyncIterable<SseMessage>): AsyncIterable<StreamEvent>
}

class Cancelled extends Error {}

// Read one chunk, failing on abort or when no data arrives in time, so
// a half-dead connection cannot hang a turn forever.
async function read(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
	if (signal?.aborted) throw new Cancelled()
	let timer: ReturnType<typeof setTimeout> | undefined
	let onAbort: (() => void) | undefined
	let ms = provider.streamTimeoutMs()
	let stop = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Stream read timed out (no data for ${ms}ms)`)), ms)
		onAbort = () => reject(new Cancelled())
		signal?.addEventListener('abort', onAbort)
	})
	try {
		return await Promise.race([reader.read(), stop])
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener('abort', onAbort!)
	}
}

// Split a byte stream into SSE messages (WHATWG framing: event/data
// fields, multi-line data, CR/LF/CRLF, comments). Cancels the body when
// the consumer stops early.
async function* sse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseMessage> {
	let reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>
	let decoder = new TextDecoder()
	let buf = ''
	let event: string | undefined
	let data: string[] = []
	let dispatch = (): SseMessage | undefined => {
		let msg = data.length ? { event, data: data.join('\n') } : undefined
		event = undefined
		data = []
		return msg
	}
	let field = (line: string) => {
		if (line.startsWith(':')) return
		let colon = line.indexOf(':')
		let name = colon < 0 ? line : line.slice(0, colon)
		let value = colon < 0 ? '' : line.slice(colon + 1)
		if (value.startsWith(' ')) value = value.slice(1)
		if (name === 'event') event = value
		else if (name === 'data') data.push(value)
	}
	try {
		while (true) {
			let { done, value } = await read(reader, signal)
			buf += done ? decoder.decode() : decoder.decode(value, { stream: true })
			// A trailing \r may be half of \r\n: keep it until more arrives.
			let cut = !done && buf.endsWith('\r') ? buf.length - 1 : buf.length
			let lines = buf.slice(0, cut).split(/\r\n|\r|\n/)
			buf = lines.pop()! + buf.slice(cut)
			for (let line of lines) {
				if (line === '') {
					let msg = dispatch()
					if (msg) yield msg
				} else field(line)
			}
			if (done) {
				if (buf) field(buf)
				let msg = dispatch()
				if (msg) yield msg
				return
			}
		}
	} finally {
		reader.cancel().catch(() => {})
	}
}

function errorText(err: unknown): string {
	if (!(err instanceof Error)) return String(err)
	let code = (err as { code?: unknown }).code
	return code && !err.message.includes(String(code)) ? `${err.message} (${code})` : err.message
}

// Stream one model turn. Always yields exactly one terminal event (done
// or error) last, and never throws.
async function* stream(
	modelId: string,
	input: Omit<ProviderRequest, 'model'>,
	signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
	let cancelled: ErrorEvent = { type: 'error', message: 'Cancelled', cancelled: true }
	let id = blocks.parseModelId(modelId)
	if (!id) {
		yield { type: 'error', message: `Model id must be provider/model, got '${modelId}'` }
		return
	}
	let p = provider.state.providers[id.provider]
	if (!p) {
		let known = Object.keys(provider.state.providers).join(', ') || 'none'
		yield { type: 'error', message: `Unknown provider '${id.provider}' (known: ${known})` }
		return
	}
	try {
		let http = await p.request({ ...input, model: id.model })
		if (signal?.aborted) throw new Cancelled()
		let res = await provider.fetch(http.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...http.headers },
			body: JSON.stringify(http.body),
			signal,
		})
		if (!res.ok || !res.body) {
			let body = await res.text()
			yield { type: 'error', message: `HTTP ${res.status} from ${id.provider}`, status: res.status, body }
			return
		}
		for await (let event of p.parse(provider.sse(res.body, signal))) {
			if (signal?.aborted) throw new Cancelled()
			yield event
			if (event.type === 'done' || event.type === 'error') return
		}
		if (signal?.aborted) throw new Cancelled()
		yield { type: 'error', message: `Stream from ${id.provider} ended without finishing` }
	} catch (err) {
		yield signal?.aborted || err instanceof Cancelled ? cancelled : { type: 'error', message: errorText(err) }
	}
}

function register(name: string, p: Provider): void {
	provider.state.providers[name] = p
}

export const provider = {
	state: { providers: {} as Record<string, Provider> },
	// Longest silence tolerated mid-stream; chunks normally arrive every ~100ms.
	streamTimeoutMs: () => 120_000,
	fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
	register,
	sse,
	stream,
}
