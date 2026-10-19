// The text the model reads in provider input rebuilt from history
// (replay.ts): prompt headers and framing, a call as native-tool text,
// and what it is told of a call with no result. Tasks: 3fv, c2t, 9p.

import type { ToolCallBlock, UserText } from './blocks.ts'
import { ason } from './ason.ts'
import { titles } from './titles.ts'
import type { TurnStatus } from './replay.ts'

// Providers see one tool, `tool` (task 3fv): a call goes back as the
// text the model wrote (an unresolved one as its cmd), and a call from
// before the one native tool as the equivalent NAME { fields } text.
function asNative(b: ToolCallBlock): ToolCallBlock {
	let text =
		b.cmd ??
		(b.name === 'tool' && typeof b.input.cmd === 'string'
			? b.input.cmd
			: `${b.name.toUpperCase()} ${ason.stringify(b.input, 'short')}`)
	return { type: 'tool_call', id: b.id, name: 'tool', input: { cmd: text } }
}

// A prompt text as the model reads it, below its header: a next-round
// message also says it needn't drop its work for it.
function framed(b: UserText): string {
	let text =
		b.queuedAt === undefined
			? b.text
			: `<hal-note>Message was queued at ${b.queuedAt}, take that into account when reading it.</hal-note>\n${b.text}`
	return b.advisory ? `${replayText.nextRoundNotice}\n${text}` : text
}

// A prompt text's kind letter, as the transcript shows it (task 9p).
function letter(b: UserText): string {
	return b.from === undefined ? (b.origin === 'model' ? 's' : 'u') : b.label?.startsWith('bash ') ? 's' : 'm'
}

// The transcript header's tags for a prompt text (task c2t); none for a plain prompt.
function tags(b: UserText): string[] {
	return [
		b.from !== undefined
			? `message from ${titles.address(b.label ?? b.from)}`
			: b.origin === 'model'
				? 'Hal'
				: undefined,
		b.generatingCommand && `/${b.generatingCommand} continuation`,
		b.delivery === 'now' && 'steering',
		b.delivery === 'next-round' && !b.advisory && 'soft-steering',
		b.queuedAt !== undefined && `queued at ${replayText.clock(b.queuedAt).slice(-5)}`,
		b.advisory && 'next round',
	].filter((t): t is string => !!t)
}

// Local wall-clock HH:MM of an ISO timestamp, as YYYY-MM-DD HH:MM if
// its date differs from that of `prev`, the last stamped prompt's (or
// there is none), so a stamp past midnight isn't read as a stale date.
function clock(ts: string, prev?: string): string {
	let two = (n: number) => String(n).padStart(2, '0')
	let day = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
	let d = new Date(ts)
	let time = `${two(d.getHours())}:${two(d.getMinutes())}`
	return prev !== undefined && day(new Date(prev)) === day(d) ? time : `${day(d)} ${time}`
}

// What the model is told about a call with no recorded result. A host
// that went away, or a pause, may have cut it off mid-run.
function missingResult(status: TurnStatus | undefined): string {
	if (status === 'interrupted' || status === 'paused')
		return 'No result: the turn was interrupted, so this tool call may or may not have run.'
	return `Tool call did not run: the turn ${status ?? 'ended'}.`
}

export const replayText = {
	// Told with a next-round message delivered while the model works.
	nextRoundNotice:
		'<hal-note>Another session sent this while you were working. No need to stop your task for it.</hal-note>',
	asNative,
	framed,
	letter,
	tags,
	clock,
	missingResult,
}
