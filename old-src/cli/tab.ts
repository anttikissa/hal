import { basename } from 'path'
import type { SessionInfo } from '../protocol.ts'
import { type FormatState, createFormatState } from './format/index.ts'

export interface CliTab {
	sessionId: string
	workingDir: string
	name: string
	topic: string
	modelLabel: string
	output: string
	fmtState: FormatState
	contextStatus: string | null
	activity: string
	busy: boolean
	paused: boolean
	inputHistory: string[]
	inputDraft: string
	inputCursor: number
	halIdleSince: number
	toolBlockStart: number | null
}

export function createTabState(params: {
	sessionId: string; workingDir: string; name: string; modelLabel: string
}): CliTab {
	return {
		...params, topic: '', output: '', fmtState: createFormatState(), contextStatus: null, activity: '',
		busy: false, paused: false, inputHistory: [], inputDraft: '', inputCursor: 0, halIdleSince: Date.now(), toolBlockStart: null,
	}
}

export function activityBarText(tab: CliTab): string {
	if (tab.paused) return `Paused • ${tab.modelLabel} — Enter to resume, /queue to inspect, /drop to clear`
	if (tab.busy) return `${tab.modelLabel} • ${tab.activity || 'Working...'}`
	return `Done. • ${tab.modelLabel}`
}

export function sessionName(session: Pick<SessionInfo, 'name' | 'workingDir' | 'id'>): string {
	const explicit = typeof session.name === 'string' ? session.name.trim() : ''
	if (explicit) return explicit
	const dirName = basename(session.workingDir || '')
	const shortId = session.id.replace(/^s-/, '').slice(0, 6)
	if (dirName) return `${dirName}:${shortId}`
	return session.id.slice(0, 8)
}

function tabNameBase(tab: Pick<CliTab, 'workingDir' | 'name'>): string {
	const dir = basename(tab.workingDir || '')
	if (dir) return dir
	const fallback = tab.name.split(':', 1)[0].trim()
	return fallback || 'tab'
}

export function tabDisplayNames(items: CliTab[]): string[] {
	const counts = new Map<string, number>()
	for (const tab of items) {
		const base = tabNameBase(tab)
		counts.set(base, (counts.get(base) ?? 0) + 1)
	}
	const seen = new Map<string, number>()
	return items.map((tab) => {
		const base = tabNameBase(tab)
		if ((counts.get(base) ?? 0) <= 1) return base
		const idx = (seen.get(base) ?? 0) + 1
		seen.set(base, idx)
		return `${base}.${idx}`
	})
}

export function titleBarText(tab: Pick<CliTab, 'topic' | 'name' | 'workingDir' | 'sessionId'>): string {
	const sessionLabel = tab.name || basename(tab.workingDir || '') || tab.sessionId.slice(0, 8)
	return tab.topic ? `${tab.topic} — ${sessionLabel}` : sessionLabel
}
