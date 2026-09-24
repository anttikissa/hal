import type { SharedSessionInfo } from '../../common/ipc.ts'

type ActivityMarker = {
	glyph: '▪' | '◆' | '!' | '✗'
	tone: 'running' | 'background' | 'attention' | 'error'
	animated: boolean
}

function describe(session: SharedSessionInfo, working: boolean, summarizing: boolean): { markers: ActivityMarker[]; label: string } {
	const markers: ActivityMarker[] = []
	const states: string[] = []

	if (working && session.attention === 'new') {
		markers.push({ glyph: '◆', tone: 'attention', animated: true })
		states.push('working', 'new')
	} else if (working) {
		markers.push({ glyph: '▪', tone: 'running', animated: true })
		states.push('working')
	} else if (session.continuation === 'retry') {
		markers.push({ glyph: '✗', tone: 'error', animated: true })
		states.push('retry available')
	} else if (session.continuation === 'continue') {
		markers.push({ glyph: '!', tone: 'attention', animated: false })
		states.push('paused')
	} else if (session.attention === 'new') {
		markers.push({ glyph: '◆', tone: 'attention', animated: false })
		states.push('new')
	}

	if (summarizing) {
		markers.push({ glyph: '▪', tone: 'background', animated: true })
		states.push('summarizing')
	}

	return { markers, label: states.join(', ') || 'idle' }
}

function ordered(sessions: SharedSessionInfo[], selected: string, working: Record<string, boolean>, summarizing: Record<string, boolean> = {}): SharedSessionInfo[] {
	function priority(session: SharedSessionInfo): number {
		if (session.id === selected) return 0
		if (working[session.id] || summarizing[session.id]) return 1
		if (session.attention === 'new' || session.continuation) return 2
		return 3
	}
	// A stable sort retains terminal tab order within each priority group.
	return [...sessions].sort((a, b) => priority(a) - priority(b))
}

function matches(session: SharedSessionInfo, query: string, number = session.tab): boolean {
	const term = query.trim().toLowerCase()
	return !term || [number, session.name, session.id, session.cwd].some((value) => String(value ?? '').toLowerCase().includes(term))
}

function capacity(width: number, buttonWidth: number, gap: number): number {
	return Math.max(1, Math.floor((width + gap) / (buttonWidth + gap)))
}

export const sessionActivity = { describe, ordered, matches, capacity }
