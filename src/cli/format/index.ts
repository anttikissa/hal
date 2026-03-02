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

function kindLabel(kind: string): string {
	const dot = kind.indexOf('.')
	return dot >= 0 ? kind.slice(dot + 1) : kind
}

export interface FormatState { prevKind: string }
export function createFormatState(): FormatState { return { prevKind: '' } }

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
	const continuation = kind === prev && isChunk

	// Tag: <label> for new kind, <more> for continuation of same chunk kind
	const tag = continuation ? '<more> ' : (prev ? '\n' : '') + `<${kindLabel(kind)}> `

	if (isChunk) {
		const reset = kind !== prev ? RESET : ''
		return `${tag}${reset}${applyStylePerLine(style, content)}`
	}

	content = content.replace(/\n+$/, '')

	const cols = termCols()
	const blockStart = fmt.blockStart ? fmt.blockStart(cols) : ''
	const blockEnd = fmt.blockEnd ? fmt.blockEnd(cols) : ''

	const styledContent = applyStylePerLine(style, content)
	return `${tag}${blockStart}${styledContent}\n${blockEnd}`
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
