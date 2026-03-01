import type { RuntimeCommand, RuntimeEvent } from '../../protocol.ts'
import type { Formatter } from './types.ts'
import { getStyle } from './theme.ts'
import { styleLinePrefix } from '../tui/format/line-prefix.ts'
import { buildPromptBlockFormatter, buildBlockFormatter } from '../tui/format/prompt.ts'
import { applyStylePerLine } from '../tui/format/line-style.ts'

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const RESET = '\x1b[0m'

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
function termCols(): number {
	return process.stdout.columns || 80
}

function isBlockKind(kind: string): boolean {
	return kind === 'prompt' || kind === 'prompt.steering' || kind === 'line.notice'
}

function blockFormatter(build: (cols: number) => { blockStart: string; blockEnd: string; formatText(t: string): string }): Formatter {
	return {
		style: '',
		blockStart(cols: number): string { return build(cols).blockStart },
		blockEnd(cols: number): string { return build(cols).blockEnd },
		formatText(text: string): string { return build(termCols()).formatText(text) },
	}
}

function getFormatter(kind: string): Formatter {
	if (kind === 'prompt' || kind === 'prompt.steering') {
		const steering = kind === 'prompt.steering'
		return blockFormatter(cols => buildPromptBlockFormatter(cols, steering))
	}
	if (kind === 'line.notice') {
		return blockFormatter(cols => buildBlockFormatter(cols, getStyle('prompt.bar'), getStyle('line.warn')))
	}
	return { style: getStyle(kind) }
}

export interface FormatState { prevKind: string; trailingNL: number; blockRows: number }
export function createFormatState(): FormatState { return { prevKind: '', trailingNL: 0, blockRows: 0 } }

function trailingNL(s: string): number {
	let n = 0
	for (let i = s.length - 1; i >= 0 && s[i] === '\n'; i--) n++
	return n
}

export function pushFragment(kind: string, text: string, st: FormatState): string {
	const prev = st.prevKind
	st.prevKind = kind

	const fmt = getFormatter(kind)
	const style = fmt.style
	let content = fmt.formatText ? fmt.formatText(text) : text
	if (kind === 'line.tool' || kind === 'local.queue' || kind === 'local.tab' || kind === 'local.tabs') {
		content = styleLinePrefix(kind, content)
	}

	const isChunk = kind.startsWith('chunk.')
	const wasChunk = prev.startsWith('chunk.')
	const isPrompt = kind === 'prompt' || kind === 'prompt.steering'
	const newSection = prev !== '' && (kind !== prev || isBlockKind(kind))

	// Section separator: ensure exactly one blank line between sections.
	let sep = ''
	if (newSection) {
		if (wasChunk && isPrompt) sep = ` ${getStyle('line.warn')}--${RESET}`
		const nlSoFar = sep ? trailingNL(sep) : st.trailingNL
		sep += '\n'.repeat(Math.max(0, 2 - nlSoFar))
	}

	if (isChunk) {
		const reset = kind !== prev ? RESET : ''
		const out = `${sep}${reset}${applyStylePerLine(style, content)}`
		st.trailingNL = trailingNL(out)
		return out
	}

	// Strip trailing newlines from content — the template adds exactly one.
	content = content.replace(/\n+$/, '')

	const cols = termCols()
	const blockStart = fmt.blockStart ? fmt.blockStart(cols) : ''
	const blockEnd = fmt.blockEnd ? fmt.blockEnd(cols) : ''

	// In-place redraw: steering immediately follows a queued prompt block.
	let redraw = ''
	if (kind === 'prompt.steering' && prev === 'prompt' && st.blockRows > 0) {
		redraw = `\x1b[${st.blockRows}A\x1b[J`
	}

	const styledContent = applyStylePerLine(style, content)
	const out = `${redraw}${sep}${blockStart}${styledContent}\n${blockEnd}`

	st.blockRows = isBlockKind(kind) ? (out.match(/\n/g) ?? []).length : 0
	st.trailingNL = trailingNL(out)
	return out
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

	return ''
}