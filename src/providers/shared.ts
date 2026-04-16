// Shared provider helpers.
//
// Kept separate from providers/provider.ts so concrete providers can use these
// helpers without creating a cycle back into the lazy provider loader.

const config = {
	// Generous timeout: chunks normally arrive every ~100ms, but allows for slow starts.
	streamTimeoutMs: 120_000,
}

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

export const providerShared = {
	config,
	parseRetryDelay,
	readWithTimeout,
}
