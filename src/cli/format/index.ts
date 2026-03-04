import type { RuntimeCommand, RuntimeEvent, ToolProgressEntry } from '../../protocol.ts'

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

let _showTimestamps = false

export function setShowTimestamps(enabled: boolean): void {
	_showTimestamps = enabled
}

function formatTimestamp(iso?: string): string {
	if (!iso) return ''
	const d = new Date(iso)
	const h = String(d.getHours()).padStart(2, '0')
	const m = String(d.getMinutes()).padStart(2, '0')
	return `\x1b[2m${h}:${m}\x1b[22m  `
}

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, '')
}

function kindLabel(kind: string): string {
	const dot = kind.indexOf('.')
	return dot >= 0 ? kind.slice(dot + 1) : kind
}

export interface FormatState {
	prevKind: string
	toolDashboardLines: number
}
export function createFormatState(): FormatState { return { prevKind: '', toolDashboardLines: 0 } }

export function pushFragment(kind: string, text: string, st: FormatState): string {
	const prev = st.prevKind
	st.prevKind = kind

	const isChunk = kind.startsWith('chunk.')
	const nl = prev !== '' && prev.startsWith('chunk.') ? '\n' : ''
	// const continuation = kind === prev && isChunk
	// const tag = continuation ? '\x1b[31m⏵\x1b[0m' : `${nl}<${kindLabel(kind)}> `
	const tag = (kind === prev && isChunk) ? '' : `${nl}<${kindLabel(kind)}> `

	if (isChunk) return `${tag}${text}`

	const content = text.replace(/\n+$/, '')
	return `${tag}${content}\n`
}

// ── Tool dashboard rendering ──

function fmtElapsed(ms: number): string {
	if (ms < 1000) return `${ms}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	return `${(ms / 60_000).toFixed(1)}m`
}

function fmtBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

const DIM = '\x1b[2m'
const RESET = '\x1b[22m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const RST = '\x1b[0m'

function renderToolDashboard(tools: ToolProgressEntry[]): string {
	const maxName = Math.max(...tools.map(t => t.name.length))
	const lines: string[] = []

	for (const tool of tools) {
		const name = tool.name.padEnd(maxName)
		const icon = tool.status === 'done' ? `${GREEN}✓${RST}`
			: tool.status === 'error' ? `${RED}✗${RST}`
			: `${DIM}…${RESET}`
		const elapsed = fmtElapsed(tool.elapsed)
		const bytes = fmtBytes(tool.bytes)
		lines.push(`${DIM}  ${name}  ${icon}${DIM} ${elapsed}  ${bytes}${RESET}`)

		for (let i = 0; i < 2; i++) {
			const line = tool.lastLines[i] ?? ''
			lines.push(`${DIM}  │${RESET} ${line}`)
		}
	}

	return lines.map(l => l + '\n').join('')
}

export function pushEvent(event: RuntimeEvent, localSource: RuntimeCommand['source'], st: FormatState): string {
	const ts = _showTimestamps ? formatTimestamp(event.createdAt) : ''

	if (event.type === 'chunk') {
		return pushFragment(`chunk.${event.channel}`, event.text, st)
	}

	if (event.type === 'line') {
		return pushFragment(`line.${event.level}`, `${ts}${event.text}`, st)
	}

	if (event.type === 'prompt') {
		const local =
			event.source.kind === localSource.kind && event.source.clientId === localSource.clientId
		const prefix = event.label ? `[${event.label}] ` : ''
		const text = local
			? `${ts}${prefix}${event.text}`
			: `${ts}[prompt:${event.source.kind}:${event.source.clientId.slice(0, 6)}] ${event.text}`
		const kind = event.label === 'steering' ? 'prompt.steering' : 'prompt'
		return pushFragment(kind, text, st)
	}

	if (event.type === 'command' && event.phase === 'failed') {
		return pushFragment(
			'command.failed',
			`[command:${event.commandId}] ${event.message ?? 'unknown'}`,
			st,
		)
	}

	if (event.type === 'tool_progress') {
		const allDone = event.tools.every(t => t.status !== 'running')
		let prefix = ''

		// Erase previous dashboard if this is an update
		if (st.toolDashboardLines > 0) {
			prefix = `\x1b[${st.toolDashboardLines}A\x1b[J`
		} else {
			// First dashboard — add separator from previous content
			const prev = st.prevKind
			if (prev !== '' && prev.startsWith('chunk.')) prefix = '\n'
		}

		const dashboard = renderToolDashboard(event.tools)
		// Count lines: each tool produces 3 lines
		const lineCount = event.tools.length * 3
		st.toolDashboardLines = allDone ? 0 : lineCount
		st.prevKind = 'tool_progress'
		return prefix + dashboard
	}

	return ''
}
