import type { SharedSessionInfo } from '../ipc.ts'
import { sessions as sessionStore } from '../server/sessions.ts'
import type { HistoryEntry } from '../server/sessions.ts'
import type { Block } from '../cli/blocks.ts'
import { time } from '../utils/time.ts'

const LAST_ACTIVE_THRESHOLD_MS = 24 * 60 * 60 * 1000
const LAST_ACTIVE_NOTICE_PREFIX = 'This session was last active '

function emptyUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
}

function entryActivityTs(entry: HistoryEntry): number | null {
	if (entry.type === 'input_history') return null
	if (entry.type === 'info' && entry.level !== 'error') return null
	return entry.ts ? Date.parse(entry.ts) : null
}

function blockActivityTs(block: Block): number | null {
	if (block.type === 'info' || block.type === 'warning' || block.type === 'startup' || block.type === 'fork') return null
	return block.ts ?? null
}

function lastActiveTs(entries: HistoryEntry[]): number | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const ts = entryActivityTs(entries[i]!)
		if (ts != null && Number.isFinite(ts)) return ts
	}
	return undefined
}

function removeLastActiveNotice(tab: any): void {
	tab.history = tab.history.filter((block: Block) => !(block.type === 'info' && block.text.startsWith(LAST_ACTIVE_NOTICE_PREFIX)))
}

function addLastActiveNotice(tab: any): void {
	removeLastActiveNotice(tab)
	let lastTs = tab.lastActiveTs
	for (let i = tab.history.length - 1; i >= 0; i--) {
		const ts = blockActivityTs(tab.history[i]!)
		if (ts != null) {
			lastTs = lastTs ? Math.max(lastTs, ts) : ts
			break
		}
	}
	if (!lastTs) return
	if (Date.now() - lastTs <= LAST_ACTIVE_THRESHOLD_MS) return
	tab.history.push({ type: 'info', text: time.formatLastActiveNotice(lastTs), ts: Date.now() })
}

function load(info: SharedSessionInfo) {
	const meta = sessionStore.loadSessionMeta(info.id)
	const { entries: history, parentCount, parentId } = sessionStore.loadAllHistoryWithOrigin(info.id)
	const usage = emptyUsage()
	for (const entry of history) {
		if (entry.type !== 'assistant' || !entry.usage) continue
		usage.input += entry.usage.input ?? 0
		usage.output += entry.usage.output ?? 0
		usage.cacheRead += entry.usage.cacheRead ?? 0
		usage.cacheCreation += entry.usage.cacheCreation ?? 0
	}
	return {
		id: info.id, name: meta?.name ?? info.name ?? info.id, cwd: info.cwd || meta?.workingDir, model: info.model || meta?.model,
		history, parentEntryCount: parentCount, liveHistory: sessionStore.loadLive(info.id).blocks as Block[], usage,
		contextUsed: meta?.context?.used ?? 0, contextMax: meta?.context?.max ?? 0, forkedFrom: meta?.forkedFrom ?? parentId, lastActiveTs: lastActiveTs(history),
	}
}

export const sessionLoader = { addLastActiveNotice, load }
