import { open, stat } from 'fs/promises'
import { watch, type FSWatcher } from 'fs'

/**
 * Create a ReadableStream that tails a file from a byte offset.
 * Uses fs.watch (kqueue/inotify) to wake on changes, with a polling
 * fallback to catch missed notifications (common on macOS kqueue).
 * The stream emits raw bytes (new data appended since last read).
 * Closing the stream (via reader.cancel or break) cleans up the watcher.
 */
export function tailFile(
	path: string,
	startOffset = 0,
	options: { dropOnTruncate?: boolean } = {},
): ReadableStream<Uint8Array> {
	let offset = startOffset
	let watcher: FSWatcher | null = null
	let pollTimer: ReturnType<typeof setInterval> | null = null

	return new ReadableStream<Uint8Array>({
		start(controller) {
			let reading = false
			let pending = false

			const read = async () => {
				if (reading) {
					pending = true
					return
				}
				reading = true
				try {
					// Loop to drain any data that arrived while we were reading
					do {
						pending = false
						try {
							const size = (await stat(path)).size
							if (size < offset) {
								if (options.dropOnTruncate) {
									offset = size
									continue
								}
								offset = 0 // file was truncated
							}
							if (size === offset) continue
							const len = size - offset
							const fh = await open(path, 'r')
							const buf = Buffer.alloc(len)
							const { bytesRead } = await fh.read(
								buf,
								0,
								len,
								offset,
							)
							await fh.close()
							if (bytesRead === 0) continue
							offset += bytesRead
							controller.enqueue(
								bytesRead < len
									? buf.subarray(0, bytesRead)
									: buf,
							)
						} catch (e: any) {
							if (e?.code === 'ENOENT') continue
							// Do not kill the stream on transient errors.
						}
					} while (pending)
				} finally {
					reading = false
				}
			}

			watcher = watch(path, { persistent: false }, () => {
				void read()
			})
			// Poll every 200ms as fallback for missed fs.watch events
			pollTimer = setInterval(() => {
				void read()
			}, 200)
			if (pollTimer.unref) pollTimer.unref()

			// Initial read in case there is already data past startOffset.
			void read()
		},
		cancel() {
			if (watcher) {
				watcher.close()
				watcher = null
			}
			if (pollTimer) {
				clearInterval(pollTimer)
				pollTimer = null
			}
		},
	})
}
