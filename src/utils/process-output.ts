import { helpers } from './helpers.ts'

interface LimitedRead {
	text: string
	truncated: boolean
}

/** Drop the final partial record after byte truncation while preserving a line that ended exactly at the boundary. */
function completeLines(text: string, suffix: string): string {
	const content = text.slice(0, -suffix.length)
	let end = content.lastIndexOf('\n')
	if (content.endsWith('\n')) end = content.length - 1
	if (end < 0) return suffix
	return content.slice(0, end) + suffix
}

async function readLimited(stream: ReadableStream<Uint8Array> | null | undefined, limitBytes: number, suffix: string, onLimit?: () => void, onOutput?: (text: string) => void): Promise<LimitedRead> {
	if (!stream) return { text: '', truncated: false }

	const reader = stream.getReader()
	const decoder = new TextDecoder()
	const chunks: Uint8Array[] = []
	let keptBytes = 0
	let truncated = false

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value) continue

			if (keptBytes < limitBytes) {
				const keepBytes = Math.min(value.byteLength, limitBytes - keptBytes)
				if (keepBytes > 0) {
					const kept = value.slice(0, keepBytes)
					chunks.push(kept)
					keptBytes += keepBytes
					const text = decoder.decode(kept, { stream: true })
					if (text) onOutput?.(text)
				}
				if (keepBytes === value.byteLength) continue
			}

			if (!truncated) {
				truncated = true
				if (onLimit) {
					onLimit()
					await reader.cancel().catch(() => {})
					break
				}
			}
		}
	} finally {
		reader.releaseLock()
	}

	const tail = decoder.decode()
	if (tail) onOutput?.(tail)
	const text = new TextDecoder().decode(Buffer.concat(chunks))
	if (!truncated) return { text, truncated }
	return { text: helpers.truncateUtf8(text + suffix, limitBytes, suffix), truncated }
}

export const processOutput = { readLimited, completeLines }
