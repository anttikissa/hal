import { watch, statSync, writeFileSync } from 'fs'
import { dirname, basename } from 'path'

/**
 * Tail a file from its current end, creating it if missing.
 * Uses fs.watch for notifications and Bun.file().slice() for reads.
 * cancel() the returned stream to stop watching.
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
		// Create the file if it doesn't exist, so fs.watch has something to watch
		writeFileSync(path, '')
	}

	let resolve: (() => void) | null = null
	let pending = false // tracks events that fired while we were busy
	// Watch the parent directory, not the file itself. Atomic rename/update
	// patterns can replace the file inode, which makes direct file watches on
	// macOS miss later appends. Directory watch keeps working across rewrites.
	const watcher = watch(dirname(path), { persistent: false }, (_, filename) => {
		if (filename && filename !== basename(path)) return
		pending = true
		resolve?.()
	})

	let stopped = false

	return new ReadableStream({
		async pull(controller) {
			while (!stopped) {
				// Only wait for fs.watch if we have no pending notification
				if (!pending) await new Promise<void>(r => (resolve = r))
				pending = false
				if (stopped) break

				const size = fileSize(path)
				// Truncation: reset to beginning
				if (size < offset) offset = 0
				if (size > offset) {
					const buf = await Bun.file(path).slice(offset, size).arrayBuffer()
					offset = size
					controller.enqueue(new Uint8Array(buf))
					// If more data arrived while we were reading, loop
					// immediately instead of waiting for another fs.watch event.
					// This prevents missed events under burst writes.
					const newSize = fileSize(path)
					if (newSize > offset) pending = true
					return
				}
			}
		},
		cancel() {
			stopped = true
			watcher.close()
			resolve?.()
		},
	})
}

export const tails = { tailFile }
