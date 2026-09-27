// Provider interface and the shared HTTP/SSE plumbing behind it. A
// provider only maps a neutral request to one HTTP request and parses
// SSE messages back into stream events; fetch, SSE framing, timeouts
// and abort live here once. Wire mappings: tasks/7f/mapping.md.

import { blocks, type ErrorEvent, type Message, type StreamEvent } from '../common/blocks.ts'
import { clock } from './clock.ts'
import { limits } from './limits.ts'

export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> }

export type ProviderRequest = {
	// Model name without the "provider/" prefix.
	model: string
	system?: string
	messages: Message[]
	tools?: ToolDef[]
	maxTokens?: number
	// An image block's bytes as base64 (the session's blob, task 2a),
	// read as the request is built; undefined if they are gone.
	image?: (blob: string) => string | undefined
}

// `account` names the credentials used, for providers with several
// (rate limits are per account; a 401 is reported back by name).
export type HttpRequest = { url: string; headers: Record<string, string>; body: unknown; account?: string }

type Failure = NonNullable<ErrorEvent['failure']>

// One server-sent event. `data` stays text: not every stream is all
// JSON (Chat Completions ends with "[DONE]").
export type SseMessage = { event: string | undefined; data: string }

export type Provider = {
	// May be async, e.g. to refresh credentials; throwing becomes an error
	// event, keeping the error's `failure` and `retryAt` if it has them.
	request(req: ProviderRequest): HttpRequest | Promise<HttpRequest>
	// The account's credentials were rejected (401).
	rejected?(account: string): void
	// Should end with done or error; shared code adds an error if not.
	parse(messages: AsyncIterable<SseMessage>): AsyncIterable<StreamEvent>
	// The model names it offers (without "provider/"), for the picker.
	models?(signal: AbortSignal): Promise<string[]>
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
			let { done, value } = await read(reader, signal).catch((e) => {
				// A dropped or stalled connection: trying again may work.
				if (e instanceof Error && !(e instanceof Cancelled)) (e as { failure?: Failure }).failure ??= 'temporary'
				throw e
			})
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

// What fixes an HTTP failure, if anything does.
function failure(status: number | undefined): Failure | undefined {
	if (status === 429) return 'limited'
	if (status === 401) return 'auth'
	if (status === 408 || (status !== undefined && status >= 500)) return 'temporary'
	return undefined
}

// The provider's own words from an error body, for the user.
function detail(body: string): string {
	try {
		let v = JSON.parse(body)
		let m = v?.error?.message ?? v?.message ?? (typeof v?.error === 'string' ? v.error : undefined)
		if (typeof m === 'string') return m
	} catch {}
	return body.trim().replace(/\s+/g, ' ').slice(0, 300)
}

// When a rate limit lifts (epoch ms), from whichever of retry-after
// (seconds or a date), Anthropic's unified reset (unix seconds) or a
// reset in the body (OpenAI usage limits) says latest.
function resetAt(headers: Headers, body: string): number | undefined {
	let now = clock.now()
	let times: number[] = []
	let after = headers.get('retry-after')
	if (after) times.push(/^\d+(\.\d+)?$/.test(after.trim()) ? now + Number(after) * 1000 : Date.parse(after))
	let unified = Number(headers.get('anthropic-ratelimit-unified-reset') ?? NaN)
	if (unified > 0) times.push(unified * 1000)
	try {
		let e = JSON.parse(body)?.error
		if (typeof e?.resets_at === 'number') times.push(e.resets_at * 1000)
		if (typeof e?.resets_in_seconds === 'number') times.push(now + e.resets_in_seconds * 1000)
	} catch {}
	let valid = times.filter((t) => Number.isFinite(t))
	return valid.length ? Math.max(...valid) : undefined
}

// Classifies a failed round and remembers what it teaches: a rate
// limit (per account, or per model for providers without accounts)
// and rejected credentials. With an account, the limit is that
// account's: retry at once, which picks the next one (auth.ts).
function failed(p: Provider, modelId: string, account: string | undefined, e: ErrorEvent, reset?: number): ErrorEvent {
	e.failure ??= provider.failure(e.status)
	let now = clock.now()
	if (e.status === 429) {
		if (account) {
			limits.set(limits.key(modelId, account), reset ?? now + provider.accountLimitMs())
			e.retryAt = now
		} else if (reset !== undefined) {
			limits.set(limits.key(modelId), reset)
			e.retryAt = reset
		}
	}
	if (e.status === 401 && account && p.rejected) {
		p.rejected(account)
		e.retryAt = now
	}
	return e
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
	// A connection open while the machine slept is usually dead with no
	// error to show for it: drop it (guard for laptop sleep).
	let conn = new AbortController()
	let slept = false
	let stopConn = () => conn.abort()
	signal?.addEventListener('abort', stopConn)
	let offWake = clock.onWake(() => {
		slept = true
		conn.abort()
	})
	try {
		let http = await p.request({ ...input, model: id.model })
		if (signal?.aborted) throw new Cancelled()
		let limited = limits.until(limits.key(modelId, http.account))
		if (limited) {
			yield { type: 'error', message: `${modelId} is rate limited`, failure: 'limited', retryAt: limited }
			return
		}
		let res: Response
		try {
			res = await provider.fetch(http.url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...http.headers },
				body: JSON.stringify(http.body),
				signal: conn.signal,
			})
		} catch (e) {
			if (e instanceof Error) (e as { failure?: Failure }).failure ??= 'temporary'
			throw e
		}
		if (!res.ok || !res.body) {
			let body = await res.text()
			let message = `HTTP ${res.status} from ${id.provider}`
			let text = provider.detail(body)
			if (text) message += `: ${text}`
			yield failed(p, modelId, http.account, { type: 'error', message, status: res.status, body }, provider.resetAt(res.headers, body))
			return
		}
		for await (let event of p.parse(provider.sse(res.body, conn.signal))) {
			if (signal?.aborted) throw new Cancelled()
			if (event.type === 'error') {
				yield failed(p, modelId, http.account, event)
				return
			}
			yield event
			if (event.type === 'done') return
		}
		if (signal?.aborted) throw new Cancelled()
		yield { type: 'error', message: `Stream from ${id.provider} ended without finishing`, failure: 'temporary' }
	} catch (err) {
		if (signal?.aborted) yield cancelled
		else if (slept) yield { type: 'error', message: 'connection lost (the computer slept)', failure: 'temporary' }
		else if (err instanceof Cancelled) yield cancelled
		else {
			let e: ErrorEvent = { type: 'error', message: errorText(err) }
			let { failure, retryAt } = err as { failure?: Failure; retryAt?: number }
			if (failure) e.failure = failure
			if (typeof retryAt === 'number') e.retryAt = retryAt
			yield e
		}
	} finally {
		offWake()
		signal?.removeEventListener('abort', stopConn)
	}
}

function register(name: string, p: Provider): void {
	provider.state.providers[name] = p
}

export const provider = {
	// Told to the model in place of an image a request cannot carry.
	imageNote: (why: string): string => `<meta>An image was attached here, but ${why}.</meta>`,
	state: { providers: {} as Record<string, Provider> },
	// Longest silence tolerated mid-stream; chunks normally arrive every ~100ms.
	streamTimeoutMs: () => 120_000,
	// How long an account that hit 429 without a reset time is skipped.
	accountLimitMs: () => 60_000,
	fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
	register,
	failure,
	detail,
	resetAt,
	sse,
	stream,
}
