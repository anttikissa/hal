// Append-only log backed by an ASONL file (one JSON value per line, see ason.ts).
// Each append serializes items with `stringify(item, 'short')` and writes them as
// newline-delimited text. Supports tail-following via byte offset for live streaming.
//
// Used for IPC commands, events, and conversation message logs.

import { appendFile, readFile, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { stringify, parseAll, parseStream } from './ason.ts'
import { tailFile } from './tail-file.ts'

export class Log<T> {
	constructor(public readonly path: string) {}

	async append(...items: T[]): Promise<void> {
		await appendFile(this.path, items.map(i => stringify(i, 'short')).join('\n') + '\n')
	}

	async readAll(): Promise<T[]> {
		if (!existsSync(this.path)) return []
		try { return parseAll(await readFile(this.path, 'utf-8')) as T[] }
		catch { return [] }
	}

	tail(fromOffset?: number): { items: AsyncGenerator<T>; cancel(): void } {
		const stream = tailFile(this.path, fromOffset)
		const reader = stream.getReader()
		let cancelled = false
		const wrapped = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (cancelled) { controller.close(); return }
				const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }))
				done ? controller.close() : controller.enqueue(value)
			},
		})
		return {
			items: parseStream(wrapped) as AsyncGenerator<T>,
			cancel() { cancelled = true; reader.cancel() },
		}
	}

	async offset(): Promise<number> {
		try { return (await stat(this.path)).size } catch { return 0 }
	}

	async trim(keep: number): Promise<void> {
		const all = await this.readAll()
		if (all.length <= keep) return
		await writeFile(this.path, all.slice(-keep).map(e => stringify(e, 'short')).join('\n') + '\n')
	}

	async ensure(): Promise<void> {
		if (!existsSync(this.path)) await writeFile(this.path, '')
	}
}
