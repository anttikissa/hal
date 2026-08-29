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

function shortName(session: SharedSessionInfo): string {
	if (session.name && session.name !== session.id) return session.name
	return session.id.replace(/^\d+-/, '') || session.id
}

export const sessionActivity = { describe, shortName }
