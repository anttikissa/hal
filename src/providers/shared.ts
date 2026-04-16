// Shared provider helpers.
//
// Kept separate from providers/provider.ts so concrete providers can use these
// helpers without creating a cycle back into the lazy provider loader.

import type { Credential } from '../auth.ts'

const config = {
	// Generous timeout: chunks normally arrive every ~100ms, but allows for slow starts.
	streamTimeoutMs: 120_000,
}

const compatEndpoints: Record<string, string> = {
	openrouter: 'https://openrouter.ai/api/v1',
	google: 'https://generativelanguage.googleapis.com/v1beta/openai',
	grok: 'https://api.x.ai/v1',
}

const sseDone = Symbol('sseDone')

type SseEvent = any | typeof sseDone

/** Extract retry delay in ms from HTTP response headers or body. */
function parseRetryDelay(res: Response, body?: string): number | undefined {
	// Standard Retry-After header (seconds or HTTP date).
	const header = res.headers.get('retry-after')
	if (header) {
		const sec = Number(header)
		if (!isNaN(sec) && sec > 0) return Math.ceil(sec * 1000)
		const date = Date.parse(header)
		if (!isNaN(date)) return Math.max(1000, date - Date.now())
	}

	// Google-style retryDelay in JSON body details.
	if (body) {
		try {
			let json = JSON.parse(body)
			if (Array.isArray(json)) json = json[0]
			const details = json?.error?.details ?? json?.details
			if (Array.isArray(details)) {
				for (const d of details) {
					const delay = d?.retryDelay
					if (typeof delay === 'string') {
						const m = delay.match(/^(\d+(?:\.\d+)?)s$/)
						if (m) return Math.ceil(Number(m[1]) * 1000)
					}
				}
			}
		} catch {}
	}

	return undefined
}

/** Extract resets_in_seconds from error response bodies (Anthropic/OpenAI rate limit format). */
function parseResetsInSeconds(body: string | undefined): number | undefined {
	if (!body) return undefined
	try {
		const json = JSON.parse(body)
		const secs = json?.error?.resets_in_seconds ?? json?.resets_in_seconds
		if (typeof secs === 'number' && secs > 0) return secs * 1000
	} catch {}
	return undefined
}

/** Race reader.read() against a timeout to detect network drops. */
async function readWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ done: boolean; value?: Uint8Array }> {
	let timer: Timer
	const timeout = new Promise<never>((_, reject) => {
		const ms = config.streamTimeoutMs
		// Reject stalled reads so a half-dead TCP connection cannot hang forever.
		timer = setTimeout(() => reject(new Error(`Stream read timed out (no data for ${ms}ms)`)), ms)
	})
	try {
		return await Promise.race([reader.read(), timeout])
	} finally {
		clearTimeout(timer!)
	}
}

/**
 * Iterate parsed SSE JSON payloads. Malformed JSON lines are ignored because
 * providers occasionally send harmless junk before the next valid event.
 */
async function* iterateJsonSse(
	body: ReadableStream<Uint8Array>,
	options: { trim?: 'end' | 'both'; doneSentinel?: string } = {},
): AsyncGenerator<SseEvent> {
	const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>
	const decoder = new TextDecoder()
	let buf = ''
	const trim = options.trim ?? 'end'

	try {
		while (true) {
			const { done, value } = await readWithTimeout(reader)
			if (done) break
			buf += decoder.decode(value, { stream: true })
			let nl: number
			while ((nl = buf.indexOf('\n')) !== -1) {
				const raw = buf.slice(0, nl)
				buf = buf.slice(nl + 1)
				const line = trim === 'both' ? raw.trim() : raw.trimEnd()
				if (!line.startsWith('data: ')) continue
				const data = line.slice(6)
				if (options.doneSentinel && data === options.doneSentinel) {
					yield sseDone
					continue
				}
				try {
					yield JSON.parse(data)
				} catch {}
			}
		}
	} finally {
		reader.releaseLock()
	}
}

/** Normalize streamed tool JSON parse failures into one consistent message. */
function parseToolInput(json: string): { input: Record<string, unknown>; parseError?: string } {
	try {
		return { input: JSON.parse(json || '{}') }
	} catch {
		return {
			input: {},
			parseError: `Failed to parse tool input JSON (${json.length} chars): ${json.slice(0, 200)}`,
		}
	}
}

function formatAccountLabel(credential: Credential): string {
	if (credential.email) return credential.email
	if (credential.total && credential.index != null) return `account ${credential.index + 1}/${credential.total}`
	return 'current account'
}

function formatRotationActivity(providerLabel: string, credential: Credential): string | undefined {
	if (!credential.total || credential.total < 2 || credential.index == null) return undefined
	return `${providerLabel} ${credential.index + 1}/${credential.total} · ${formatAccountLabel(credential)}`
}

function formatRotationMessage(
	providerLabel: string,
	current: Credential,
	next: Credential | undefined,
	retryAfterMs: number,
	fast: boolean,
): string {
	const total = current.total ?? 1
	const currentLabel = formatAccountLabel(current)
	const nextLabel = next ? formatAccountLabel(next) : 'the next available account'
	if (fast) return `${providerLabel} rotation: ${total} accounts. 429 on ${currentLabel}. Trying ${nextLabel} next.`
	return `${providerLabel} rotation: ${total} accounts. 429 on ${currentLabel}. All accounts cooling down. Next: ${nextLabel} in ${Math.ceil(retryAfterMs / 1000)}s.`
}

export const providerShared = {
	config,
	compatEndpoints,
	sseDone,
	parseRetryDelay,
	parseResetsInSeconds,
	readWithTimeout,
	iterateJsonSse,
	parseToolInput,
	formatRotationActivity,
	formatRotationMessage,
}
