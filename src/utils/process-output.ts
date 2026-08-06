import { helpers } from './helpers.ts'

interface LimitedRead {
	text: string
	truncated: boolean
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

export const processOutput = { readLimited }
