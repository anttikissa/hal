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
	toolProgressLines: number
	termWidth: number
}
export function createFormatState(): FormatState {
	return { prevKind: '', toolProgressLines: 0, termWidth: 80 }
}

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

// ── Tool progress rendering ──

const DIM = '\x1b[2m'
const RESET = '\x1b[22m'

function fmtElapsed(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`
}

function fmtBytes(bytes: number): string {
	if (bytes < 1000) return `${bytes} bytes`
	if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`
	return `${(bytes / 1_000_000).toFixed(1)} MB`
}

function truncLine(text: string, maxWidth: number): string {
	// Strip ANSI to measure visible length, truncate if needed
	const visible = stripAnsi(text)
	if (visible.length <= maxWidth) return text
	// Walk the raw string, tracking visible chars
	let vis = 0, i = 0
	while (i < text.length && vis < maxWidth - 1) {
		if (text[i] === '\x1b') {
			const m = text.slice(i).match(/^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/)
			if (m) { i += m[0].length; continue }
		}
		vis++; i++
	}
	// Include any trailing ANSI sequences (resets)
	let tail = i
	while (tail < text.length && text[tail] === '\x1b') {
		const m = text.slice(tail).match(/^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/)
		if (m) { tail += m[0].length } else break
	}
	return text.slice(0, i) + '…' + text.slice(i, tail)
}

function truncPlain(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return ''
	if (text.length <= maxWidth) return text
	if (maxWidth === 1) return '…'
	return `${text.slice(0, maxWidth - 1)}…`
}

function renderToolBlock(tool: ToolProgressEntry, termWidth: number): string {
	const CONTENT_LINES = 3
	const tag = `<tool.${tool.name}> `
	const statusLabel = tool.status === 'running' ? 'pending' : tool.status
	const stats = `(${fmtElapsed(tool.elapsed)}, ${fmtBytes(tool.bytes)}; ${statusLabel})`

	const headerPrefix = `${tag}${DIM}--- ${RESET}`
	const headerSuffix = `${DIM} --- ${stats} ${RESET}`
	const minGap = `${DIM} --- ${RESET}`
	const fixedVis = stripAnsi(headerPrefix).length + stripAnsi(minGap).length + stripAnsi(headerSuffix).length
	const availableForSummary = Math.max(0, termWidth - fixedVis)
	const summary = truncPlain(tool.inputSummary, availableForSummary)
	const header = truncLine(`${headerPrefix}${summary}${minGap}${headerSuffix}`, termWidth)

	const lines: string[] = [header]
	const total = tool.totalLines
	const last = tool.lastLines.slice(-CONTENT_LINES)

	if (total <= CONTENT_LINES) {
		for (let i = 0; i < CONTENT_LINES; i++) {
			const content = last[i] ?? ''
			lines.push(truncLine(`${DIM}${tag}${RESET}${content}`, termWidth))
		}
	} else {
		const hidden = total - CONTENT_LINES
		lines.push(`${DIM}${tag}[+ ${hidden} more lines]${RESET}`)
		for (const content of last) lines.push(truncLine(`${DIM}${tag}${RESET}${content}`, termWidth))
	}

	return lines.map((l) => l + '\n').join('')
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

		// Erase previous tool blocks if this is an update
		if (st.toolProgressLines > 0) {
			prefix = `\x1b[${st.toolProgressLines}A\x1b[J`
		} else {
			// First render — add separator from previous chunk content
			const prev = st.prevKind
			if (prev !== '' && prev.startsWith('chunk.')) prefix = '\n'
		}

		const linesPerTool = 4 // 1 header + 3 content
		let body = ''
		for (const tool of event.tools) {
			body += renderToolBlock(tool, st.termWidth)
		}

		const lineCount = event.tools.length * linesPerTool
		st.toolProgressLines = allDone ? 0 : lineCount
		st.prevKind = 'tool_progress'
		return prefix + body
	}

	return ''
}
