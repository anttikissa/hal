// Line-delimited ASON over a byte stream, such as a socket: one message
// per line. Short ASON escapes newlines inside strings, so a newline
// always ends a message. Encode with ason.stringifyLine.

import { ason } from './ason.ts'

// Returns a feeder for chunks as they arrive. Each complete line is
// parsed and passed to onValue; a line that fails to parse, or grows
// past maxLine characters, goes to onError and the next line starts
// afresh, so one bad message never desyncs the stream.
function decoder(
	onValue: (value: unknown) => void,
	onError: (error: Error) => void,
	maxLine = lines.maxLine(),
): (chunk: string | Uint8Array) => void {
	let text = new TextDecoder()
	let buf = ''
	// Inside an overlong line: discard until its newline.
	let skipping = false
	return (chunk) => {
		buf += typeof chunk === 'string' ? chunk : text.decode(chunk, { stream: true })
		let nl: number
		while ((nl = buf.indexOf('\n')) >= 0) {
			let line = buf.slice(0, nl)
			buf = buf.slice(nl + 1)
			if (skipping) {
				skipping = false
				continue
			}
			if (!line.trim()) continue
			let value: unknown
			try {
				value = ason.parse(line)
			} catch (e: any) {
				onError(e instanceof Error ? e : new Error(String(e)))
				continue
			}
			onValue(value)
		}
		if (buf.length > maxLine) {
			if (!skipping) onError(new Error(`line longer than ${maxLine} characters`))
			skipping = true
			buf = ''
		}
	}
}

export const lines = {
	// Snapshots carry whole conversations, so this is generous.
	maxLine: () => 256 * 1024 * 1024,
	decoder,
}
