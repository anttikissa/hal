// Presentation of a Bash result. Keep the original output in history
// and provider input; the UI shows a nonzero status in the card's
// title instead of an output row (tasks wm0, kx0).

import type { Shown } from './transcript.ts'

const STATUS = /^\[exit (\d+)\]\n?/

// Status belongs to the header; interrupted calls replace it with a stop note.
function display(output: string, interrupted = false): string {
	return bashResult.trim(output.replace(interrupted ? /^\[[^\n]*\]\n?/ : STATUS, ''))
}

// Text without blank lines at either end: they are never shown.
function trim(text: string): string {
	return text.replace(/^(?:[ \t]*\n)+/, '').trimEnd()
}

// 'exit 1' for a nonzero exit, else undefined.
function status(output: string): string | undefined {
	let code = STATUS.exec(output)?.[1]
	return code && code !== '0' ? `exit ${code}` : undefined
}

function failure(result: { output: string; isError?: boolean; interrupted?: 'canceled' | 'stopped' }, bash = false): string | undefined {
	if (result.interrupted) return undefined
	return (bash ? bashResult.status(result.output) : undefined) ?? (result.isError ? 'failed' : undefined)
}

// A call's wall time, when it is 1 s or more: 3.2s, 50.2s, 1m 05s;
// `ticking` (a call still running) counts whole seconds: 3s.
function duration(ms: number | undefined, ticking = false): string | undefined {
	if (ms === undefined || ms < 1000) return undefined
	if (ms < 60_000 && !ticking) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`
	let s = Math.floor(ms / 1000)
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// Steering's status for a call (task ker): "canceled", "stopped, 50.2s".
function interrupted(r: { interrupted?: 'canceled' | 'stopped'; ms?: number }): string | undefined {
	if (r.interrupted !== 'stopped') return r.interrupted
	let time = bashResult.duration(r.ms)
	return time ? `stopped, ${time}` : 'stopped'
}

// Stored job labels identify literal Bash output and its original call.
export const bashResult = { background: (item: Shown) => item.type === 'prompt' ? /^bash (#t?\d+|b[0-9a-f]{6})$/.exec(item.label ?? '')?.[1] : undefined, display, trim, status, failure, duration, interrupted }
