import type { Subprocess } from 'bun'

const alive = new Set<Subprocess>()

process.on('exit', () => { for (const p of alive) p.kill() })

/** Tail a file from a byte offset (default: current end). */
export function tailFile(path: string, fromOffset?: number): ReadableStream<Uint8Array> {
	// tail -f -c +N starts from byte N (1-based); -n 0 starts from end
	const args = fromOffset !== undefined
		? ['tail', '-f', '-c', `+${fromOffset + 1}`, path]
		: ['tail', '-f', '-n', '0', path]
	const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore' })
	alive.add(proc)
	proc.exited.then(() => alive.delete(proc))
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
	return new ReadableStream({
		async pull(controller) {
			const { done, value } = await reader.read()
			done ? controller.close() : controller.enqueue(value)
		},
		cancel() {
			proc.kill()
			alive.delete(proc)
		},
	})
}
