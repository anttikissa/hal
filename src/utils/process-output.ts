import { helpers } from './helpers.ts'

interface LimitedRead {
	text: string
	truncated: boolean
}

async function readLimited(stream: ReadableStream<Uint8Array> | null | undefined, limitBytes: number, suffix: string, onLimit?: () => void): Promise<LimitedRead> {
	if (!stream) return { text: '', truncated: false }

	const reader = stream.getReader()
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
					chunks.push(value.slice(0, keepBytes))
					keptBytes += keepBytes
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

	const text = new TextDecoder().decode(Buffer.concat(chunks))
	if (!truncated) return { text, truncated }
	return { text: helpers.truncateUtf8(text + suffix, limitBytes, suffix), truncated }
}

export const processOutput = { readLimited }
