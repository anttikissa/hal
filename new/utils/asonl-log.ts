// Append-only ASONL log with tail support.
// Used for commands, events, and message logs.

import { appendFile, readFile, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { stringify, parseAll, parseStream } from './ason.ts'
import { tailFile } from './tail-file.ts'

export class AsonlLog<T> {
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
