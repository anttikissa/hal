// Parse <blink /> tags from streamed text, yielding text segments and pauses.

const BLINK_RE = /<blink\s*(?:ms="(\d+)")?\s*\/>/g
const PARTIAL_RE = /<(?:b(?:l(?:i(?:n(?:k(?:\s[^>]*)?)?)?)?)?)?$/

export const DEFAULT_BLINK_MS = 50

export interface BlinkSegment {
	type: 'text' | 'pause'
	text?: string
	ms?: number
}

/** Stateful blink parser for streaming text. */
export function createBlinkParser() {
	let buf = ''

	function drain(final: boolean): BlinkSegment[] {
		const out: BlinkSegment[] = []
		while (true) {
			BLINK_RE.lastIndex = 0
			const m = BLINK_RE.exec(buf)
			if (m) {
				if (m.index > 0) out.push({ type: 'text', text: buf.slice(0, m.index) })
				out.push({ type: 'pause', ms: m[1] ? parseInt(m[1], 10) : DEFAULT_BLINK_MS })
				buf = buf.slice(m.index + m[0].length)
				continue
			}
			break
		}

		if (final) {
			if (buf) out.push({ type: 'text', text: buf })
			buf = ''
			return out
		}

		// Hold back partial tag at end
		const partial = buf.match(PARTIAL_RE)
		if (partial) {
			const safe = buf.slice(0, partial.index!)
			if (safe) out.push({ type: 'text', text: safe })
			buf = buf.slice(partial.index!)
		} else {
			if (buf) out.push({ type: 'text', text: buf })
			buf = ''
		}
		return out
	}

	return {
		feed(chunk: string): BlinkSegment[] {
			buf += chunk
			return drain(false)
		},
		flush(): BlinkSegment[] {
			return drain(true)
		},
	}
}

export const blink = { createBlinkParser }