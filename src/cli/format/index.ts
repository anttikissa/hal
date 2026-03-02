import type { RuntimeCommand, RuntimeEvent } from '../../protocol.ts'

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

export interface FormatState { prevKind: string }
export function createFormatState(): FormatState { return { prevKind: '' } }

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
