import { statSync } from 'fs'
import type { Subprocess } from 'bun'

const alive = new Set<Subprocess>()

process.on('exit', () => { for (const p of alive) p.kill() })

/** Tail a file from its current end, creating it if missing. */
export function tailFile(path: string): ReadableStream<Uint8Array> {
	let size = 0
	try { size = statSync(path).size } catch {}
	// touch ensures the file exists; tail -f -c +N starts from byte N (1-based)
	const proc = Bun.spawn(['sh', '-c', `touch "$1" && exec tail -f -c +${size + 1} "$1"`, 'sh', path], {
		stdout: 'pipe', stderr: 'ignore',
	})
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

export const tails = { tailFile }
