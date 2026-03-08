import type { Subprocess } from 'bun'

const alive = new Set<Subprocess>()

process.on('exit', () => { for (const p of alive) p.kill() })

/** Tail a file from the current end, like `tail -f`. */
export function tailFile(path: string): ReadableStream<Uint8Array> {
	const proc = Bun.spawn(['tail', '-f', '-n', '0', path], { stdout: 'pipe', stderr: 'ignore' })
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
