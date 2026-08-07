import { statSync, writeFileSync } from 'fs'

/**
 * Tail a file from its current end, creating it if missing.
 * Reads are discovered by polling rather than filesystem notifications, which
 * can be dropped when several processes append to an IPC file at once.
 * cancel() stops a pending poll wait immediately.
 */
function fileSize(path: string): number {
	try {
		return statSync(path).size
	} catch {
		return 0
	}
}

function tailFile(path: string): ReadableStream<Uint8Array> {
	let offset = 0
	try {
		offset = statSync(path).size
	} catch {
		writeFileSync(path, '')
	}

	let stopped = false
	let wakePoll: (() => void) | null = null

	function waitForPoll(): Promise<void> {
		return new Promise(resolve => {
			let timer: ReturnType<typeof setTimeout> | null = null
			function wake(): void {
				if (timer !== null) clearTimeout(timer)
				if (wakePoll === wake) wakePoll = null
				resolve()
			}
			timer = setTimeout(wake, 100)
			wakePoll = wake
		})
	}

	return new ReadableStream({
		async pull(controller) {
			while (!stopped) {
				const size = fileSize(path)
				// Truncation: reset to beginning.
				if (size < offset) offset = 0
				if (size > offset) {
					const buf = await Bun.file(path).slice(offset, size).arrayBuffer()
					offset = size
					controller.enqueue(new Uint8Array(buf))
					return
				}

				// Use an owned one-shot timer rather than setInterval so an idle tail
				// has exactly one cancellable wait in flight.
				await waitForPoll()
			}
		},
		cancel() {
			stopped = true
			wakePoll?.()
		},
	})
}

export const tails = { tailFile }
