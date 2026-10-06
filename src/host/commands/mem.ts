// /mem: host process memory and what Hal knows it holds (task 7a).

import { heapStats } from 'bun:jsc'
import { totalmem } from 'os'
import type { SlashCommand } from '../commands.ts'
import { history } from '../history.ts'
import { pages } from '../pages.ts'
import { resources } from '../resources.ts'
import { sessions } from '../sessions.ts'
import { web } from '../web.ts'

function size(bytes: number): string {
	let units = ['B', 'KB', 'MB', 'GB']
	let i = 0
	while (bytes >= 1024 && i < units.length - 1) {
		bytes /= 1024
		i++
	}
	return `${i === 0 || bytes >= 100 ? Math.round(bytes) : bytes.toFixed(1)} ${units[i]}`
}

async function report(): Promise<string> {
	let heap = heapStats()
	let rows = [
		`rss        ${size(process.memoryUsage.rss())}`,
		`heap       ${size(heap.heapSize)} used of ${size(heap.heapCapacity)}, ${heap.objectCount} objects`,
		`machine    ${size(resources.availableMemory())} available of ${size(totalmem())}`,
		'',
		'holders',
	]
	for (let id of sessions.state.open.keys()) {
		let cached = history.state.cache.get(id)
		rows.push(`  session ${id}  ${cached ? `${cached.records.length} history records, ${size(cached.size)}` : 'history not loaded'}`)
	}
	rows.push(`  page marks  ${pages.state.marks.size} files`)
	let page = web.state.page && (await web.state.page.catch(() => undefined))
	rows.push(`  web bundle  ${page ? size(Buffer.byteLength(page.html)) : 'not built'}`)
	return rows.join('\n')
}

export const command: SlashCommand = {
	help: () => "/mem shows the host process's memory: resident size, JS heap, the sessions whose history is loaded and other holders, and the machine's free memory. /mem gc runs a full garbage collection and shows the before and after. Nothing else changes.",
	async run(args) {
		if (args && args !== 'gc') return { error: 'usage: /mem [gc]' }
		let before = await report()
		if (!args) return { say: `\`\`\`\n${before}\n\`\`\`` }
		Bun.gc(true)
		return { say: `\`\`\`\nbefore\n${before}\n\nafter gc\n${await report()}\n\`\`\`` }
	},
}
