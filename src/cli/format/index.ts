import type { RuntimeCommand, RuntimeEvent } from '../../protocol.ts'
import type { Formatter } from './types.ts'
import { getStyle } from './theme.ts'

const RESET = '\x1b[0m'

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, '')
}

function termCols(): number {
	return process.stdout.columns || 80
}

function getFormatter(kind: string): Formatter {
	if (kind === 'prompt') {
		return {
			style: getStyle('prompt.text'),
			blockStart(cols: number): string {
				const bar = getStyle('prompt.bar')
				const w = Math.max(0, cols - 1)
				return `\n${bar}${' '.repeat(w)}${RESET}\n`
			},
			blockEnd(cols: number): string {
				const bar = getStyle('prompt.bar')
				const w = Math.max(0, cols - 1)
				return `${bar}${' '.repeat(w)}${RESET}\n`
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
	const continuing = kind === prev
	prevKindBySession.set(key, kind)

	const fmt = getFormatter(kind)
	const style = fmt.style
	const reset = style ? RESET : ''
	const content = fmt.formatText ? fmt.formatText(text) : text

	if (kind === 'chunk.assistant' || kind === 'chunk.thinking') {
		// Only add blank-line separator for chunk→chunk transitions (thinking↔assistant).
		// Non-chunk types (lines, prompts) already end with \n, so no extra prefix needed.
		const isChunkTransition = !continuing && prev.startsWith('chunk.')
		const prefix = isChunkTransition ? '\n' : ''
		return `${prefix}${style}${content}${reset}`
	}

	// When previous output was a streaming chunk (no trailing newline), add one
	const needsNewline = prev.startsWith('chunk.')

	// Block decorations (e.g. prompt grey bars)
	const cols = termCols()
	const blockStart = fmt.blockStart ? fmt.blockStart(cols) : ''
	const blockEnd = fmt.blockEnd ? fmt.blockEnd(cols) : ''

	return `${needsNewline ? '\n' : ''}${blockStart}${style}${content}${reset}\n${blockEnd}`
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
			event.source.kind === localSource.kind && event.source.clientId === localSource.clientId
		const text = local
			? event.text
			: `[prompt:${event.source.kind}:${event.source.clientId.slice(0, 6)}] ${event.text}`
		return pushFragment('prompt', text, sessionId)
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
