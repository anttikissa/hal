// The Hal cursor (task 5p): a block in the Hal cursor colour that
// blinks right after the text Hal is streaming (in the thinking colour
// while it thinks), and otherwise on its own row below the transcript.
// That idle cursor is bright while the session works and, once it has
// finished, fades to grey over fadeMs. Only the shown session's current
// stream has one. Beats come from the shared pulse (pulse.ts).

import { colors } from '../common/colors.ts'
import type { Oklch } from '../common/oklch.ts'
import { states } from '../common/states.ts'
import type { Transcript } from '../common/transcript.ts'
import { pulse } from './pulse.ts'

// `stream`: after the last item's last character; `idle`: its own row.
export type HalCursor = { at: 'stream' | 'idle'; lit: boolean; color: Oklch }

// Whether the transcript's last item is text or thinking still
// streaming: the running turn's last block, not yet closed.
function streaming(t: Transcript): boolean {
	let block = t.live?.turn.blocks.at(-1)
	let item = t.items.at(-1)
	if (!t.live || t.state.type !== 'running' || !block || !item || t.items.length <= t.live.start) return false
	if (block.type === 'thinking' && block.signature !== undefined) return false
	return (block.type === 'text' || block.type === 'thinking') && item.type === block.type
}

// How far session `id`'s idle cursor has faded, 0 (working) to 1: it
// fades from when this client last saw it stop working; one never seen
// working here is faded already.
function fade(id: string, working: boolean, now: number): number {
	let st = halCursor.state
	if (working) {
		st.stopped.set(id, null)
		return 0
	}
	if (!st.stopped.has(id)) return 1
	let since = st.stopped.get(id) ?? now
	st.stopped.set(id, since)
	let ms = halCursor.fadeMs()
	// In steps, so a fade paints (and caches) a few colours, not one per beat.
	return ms > 0 ? Math.min(1, Math.round(((now - since) / ms) * 10) / 10) : 1
}

function mix(a: Oklch, b: Oklch, t: number): Oklch {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

// The cursor for transcript `t` at `beat`; none without a session.
function of(t: Transcript | undefined, beat: number, now = pulse.now()): HalCursor | undefined {
	if (!t) return undefined
	let hal = colors.assistant()
	if (halCursor.streaming(t)) {
		let thinking = t.items.at(-1)!.type === 'thinking' ? colors.thinking() : undefined
		let color = thinking ? (thinking.cursor ?? thinking.fg!) : (hal.cursor ?? hal.fg!)
		return { at: 'stream', lit: pulse.fast(beat), color }
	}
	let t0 = halCursor.fade(t.meta.id, states.busy(t.state), now)
	let color = mix(hal.cursor ?? hal.fg!, hal.cursorIdle ?? hal.cursor ?? hal.fg!, t0)
	return { at: 'idle', lit: pulse.slow(beat), color }
}

export const halCursor = {
	// `stopped`: per session seen working here, when it stopped (null
	// while it works).
	state: { stopped: new Map<string, number | null>() },
	/** How long a finished session's idle cursor takes to turn grey. */
	fadeMs: () => 5000,
	streaming,
	fade,
	of,
	reset: (): void => void (halCursor.state = { stopped: new Map() }),
}
