import { open, stat } from "fs/promises"
import { watch, type FSWatcher } from "fs"

/**
 * Create a ReadableStream that tails a file from a byte offset.
 * Uses fs.watch (kqueue/inotify) to wake on changes instead of polling.
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

	return new ReadableStream<Uint8Array>({
		start(controller) {
			const read = async () => {
				try {
					const size = (await stat(path)).size
					if (size < offset) {
						if (options.dropOnTruncate) {
							offset = size
							return
						}
						offset = 0 // file was truncated
					}
					if (size === offset) return
					const len = size - offset
					const fh = await open(path, "r")
					const buf = Buffer.alloc(len)
					const { bytesRead } = await fh.read(buf, 0, len, offset)
					await fh.close()
					if (bytesRead === 0) return
					offset += bytesRead
					controller.enqueue(bytesRead < len ? buf.subarray(0, bytesRead) : buf)
				} catch (e: any) {
					if (e?.code === "ENOENT") return // file does not exist yet
					// Do not kill the stream on transient errors.
				}
			}

			watcher = watch(path, { persistent: false }, () => {
				void read()
			})
			// Do an initial read in case there is already data past startOffset.
			void read()
		},
		cancel() {
			if (watcher) {
				watcher.close()
				watcher = null
			}
		},
	})
}
