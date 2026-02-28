import type { RuntimeCommand, RuntimeEvent } from '../../protocol.ts'
import type { Formatter } from './types.ts'
import { getStyle } from './theme.ts'
import { styleLinePrefix } from '../tui/format/line-prefix.ts'
import { buildPromptBlockFormatter, buildBlockFormatter } from '../tui/format/prompt.ts'
import { chunkPrefixForStability } from '../tui/format/chunk-stability.ts'
import { applyStylePerLine } from '../tui/format/line-style.ts'

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

// Track prevKind and last block row count per session so interleaved events
// from different sessions don't inject spurious newlines into each other's output.
const prevKindBySession = new Map<string, string>()
const lastBlockRows = new Map<string, number>()
const LOCAL_KEY = '__local__'

export function resetFormat(sessionId?: string): void {
	if (sessionId) {
		prevKindBySession.delete(sessionId)
		lastBlockRows.delete(sessionId)
	} else {
		prevKindBySession.clear()
		lastBlockRows.clear()
	}
}

export function pushFragment(kind: string, text: string, sessionId?: string | null): string {
	const key = sessionId ?? LOCAL_KEY
	const prev = prevKindBySession.get(key) ?? ''
	prevKindBySession.set(key, kind)

	const fmt = getFormatter(kind)
	const style = fmt.style
	let content = fmt.formatText ? fmt.formatText(text) : text
	if (kind === 'line.tool' || kind === 'local.queue' || kind === 'local.tab' || kind === 'local.tabs') {
		content = styleLinePrefix(kind, content)
	}

	if (kind === 'chunk.assistant' || kind === 'chunk.thinking') {
		// Keep ANSI state stable when switching channel/style so wrapped lines don't get brightness seams.
		const prefix = chunkPrefixForStability(kind, prev)
		return `${prefix}${applyStylePerLine(style, content)}`
	}

	// When previous output was a streaming chunk (no trailing newline), add one.
	// If transitioning to a prompt, show a truncation marker.
	const wasChunk = prev.startsWith('chunk.')
	const isPrompt = kind === 'prompt' || kind === 'prompt.steering'
	const truncMarker = wasChunk && isPrompt
		? ` ${getStyle('line.warn')}--\x1b[0m\n`
		: wasChunk ? '\n' : ''

	// Block decorations (e.g. prompt grey bars).
	const cols = termCols()
	const blockStart = fmt.blockStart ? fmt.blockStart(cols) : ''
	const blockEnd = fmt.blockEnd ? fmt.blockEnd(cols) : ''

	// In-place redraw: if steering immediately follows a queued prompt block
	// (nothing in between), cursor-up over the previous block and overwrite.
	let redraw = ''
	if (kind === 'prompt.steering' && prev === 'prompt') {
		const prevRows = lastBlockRows.get(key) ?? 0
		if (prevRows > 0) {
			redraw = `\x1b[${prevRows}A\x1b[J`
		}
	}

	const styledContent = applyStylePerLine(style, content)
	const output = `${truncMarker}${redraw}${blockStart}${styledContent}\n${blockEnd}`

	// Track row count for block kinds (for potential future redraw)
	if (isBlockKind(kind)) {
		lastBlockRows.set(key, (output.match(/\n/g) ?? []).length)
	} else {
		lastBlockRows.delete(key)
	}

	return output
}

export function pushEvent(event: RuntimeEvent, localSource: RuntimeCommand['source']): string {
	const sessionId = 'sessionId' in event ? event.sessionId : null
	const ts = _showTimestamps ? formatTimestamp(event.createdAt) : ''

	if (event.type === 'chunk') {
		return pushFragment(`chunk.${event.channel}`, event.text, sessionId)
	}

	if (event.type === 'line') {
		return pushFragment(`line.${event.level}`, `${ts}${event.text}`, sessionId)
	}

	if (event.type === 'prompt') {
		const local =
			event.source.kind === localSource.kind && event.source.clientId === localSource.clientId
		const prefix = event.label ? `[${event.label}] ` : ''
		const text = local
			? `${ts}${prefix}${event.text}`
			: `${ts}[prompt:${event.source.kind}:${event.source.clientId.slice(0, 6)}] ${event.text}`
		const kind = event.label === 'steering' ? 'prompt.steering' : 'prompt'
		return pushFragment(kind, text, sessionId)
	}

	if (event.type === 'command' && event.phase === 'failed') {
		return pushFragment(
			'command.failed',
			`[command:${event.commandId}] ${event.message ?? 'unknown'}`,
			sessionId,
		)
	}

	return ''
}
