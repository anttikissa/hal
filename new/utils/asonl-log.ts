// Append-only ASONL log with tail support.
// Used for commands, events, and message logs.

import { appendFile, readFile, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { stringify, parse, parseAll, parseStream } from './ason.ts'
import { tailFile } from './tail-file.ts'

export interface AsonlLog<T> {
	append(...items: T[]): Promise<void>
	readAll(): Promise<T[]>
	tail(fromOffset?: number): { items: AsyncGenerator<T>; cancel(): void }
	offset(): Promise<number>
	trim(keep: number): Promise<void>
	ensure(): Promise<void>
}

export function asonlLog<T>(path: string): AsonlLog<T> {
	return {
		async append(...items) {
			await appendFile(path, items.map(i => stringify(i, 'short')).join('\n') + '\n')
		},
		async readAll() {
			if (!existsSync(path)) return []
			try { return parseAll(await readFile(path, 'utf-8')) as T[] }
			catch { return [] }
		},
		tail(fromOffset) {
			const stream = tailFile(path, fromOffset)
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
		},
		async offset() {
			try { return (await stat(path)).size } catch { return 0 }
		},
		async trim(keep) {
			const all = await this.readAll()
			if (all.length <= keep) return
			await writeFile(path, all.slice(-keep).map(e => stringify(e, 'short')).join('\n') + '\n')
		},
		async ensure() {
			if (!existsSync(path)) await writeFile(path, '')
		},
	}
}
