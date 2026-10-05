// Presentation of a Bash result. Keep the original output in history
// and provider input; the UI shows a nonzero status in the card's
// title instead of an output row (task wm0).

const STATUS = /^\[exit (\d+)\]\n?/

// The output to show: no blank lines at either end and no `[exit 0]`;
// `titled`: no status line at all, the card's title shows it (the
// terminal; job messages and the web keep a nonzero one). `interrupted`:
// steering stopped it, so its first line is the stop note (task ker).
function display(output: string, titled = false, interrupted = false): string {
	if (titled && interrupted) return bashResult.trim(output.replace(/^\[[^\n]*\]\n?/, ''))
	let status = titled || !bashResult.status(output) ? STATUS : ''
	return bashResult.trim(output.replace(status, ''))
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

export const bashResult = { display, trim, status, duration, interrupted }
