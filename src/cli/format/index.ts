import type { RuntimeCommand, RuntimeEvent } from '../../protocol.ts'
import type { Formatter } from './types.ts'
import { getStyle } from './theme.ts'
import { styleLinePrefix } from '../tui/format/line-prefix.ts'
import { buildPromptBlockFormatter } from '../tui/format/prompt.ts'
import { chunkPrefixForStability } from '../tui/format/chunk-stability.ts'
import { applyStylePerLine } from '../tui/format/line-style.ts'

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, '')
}

function termCols(): number {
	return process.stdout.columns || 80
}

function getFormatter(kind: string): Formatter {
	if (kind === 'prompt' || kind === 'prompt.steering') {
		const steering = kind === 'prompt.steering'
		return {
			style: '',
			blockStart(cols: number): string {
				return buildPromptBlockFormatter(cols, steering).blockStart
			},
			blockEnd(cols: number): string {
				return buildPromptBlockFormatter(cols, steering).blockEnd
			},
			formatText(text: string): string {
				return buildPromptBlockFormatter(termCols(), steering).formatText(text)
			},
		}
	}
	return { style: getStyle(kind) }
}

// Track prevKind per session so interleaved events from different sessions
// don't inject spurious newlines into each other's output.
const prevKindBySession = new Map<string, string>()
const LOCAL_KEY = '__local__'

export function resetFormat(sessionId?: string): void {
	if (sessionId) {
		prevKindBySession.delete(sessionId)
	} else {
		prevKindBySession.clear()
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

	// Block decorations (e.g. prompt grey bars)
	const cols = termCols()
	const blockStart = fmt.blockStart ? fmt.blockStart(cols) : ''
	const blockEnd = fmt.blockEnd ? fmt.blockEnd(cols) : ''

	const styledContent = applyStylePerLine(style, content)
	return `${truncMarker}${blockStart}${styledContent}\n${blockEnd}`
}

export function pushEvent(event: RuntimeEvent, localSource: RuntimeCommand['source']): string {
	const sessionId = 'sessionId' in event ? event.sessionId : null

	if (event.type === 'chunk') {
		return pushFragment(`chunk.${event.channel}`, event.text, sessionId)
	}

	if (event.type === 'line') {
		return pushFragment(`line.${event.level}`, event.text, sessionId)
	}

	if (event.type === 'prompt') {
		const local =
			event.source.clientId === 'replay' ||
			(event.source.kind === localSource.kind && event.source.clientId === localSource.clientId)
		const prefix = event.label ? `[${event.label}] ` : ''
		const text = local
			? `${prefix}${event.text}`
			: `[prompt:${event.source.kind}:${event.source.clientId.slice(0, 6)}] ${event.text}`
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
