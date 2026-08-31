// Wall-clock-synced pulse clock for rendered cursor and tool indicators.
// One 5-display-frame heartbeat drives 10-frame tool and 15-frame cursor phases;
// their overlapping boundaries produce one callback and therefore one paint.

const HEARTBEAT_MS = 1000 / 12

let timer: ReturnType<typeof setTimeout> | null = null
let onChange: ((cursorFrame: boolean, toolFrame: boolean) => void) | null = null

function tick(): number {
	return Math.floor(Date.now() / 250)
}

function toolTick(): number {
	return Math.floor(Date.now() / (HEARTBEAT_MS * 2))
}

function isVisible(t = cursor.tick()): boolean {
	return t % 4 < 2
}

function isFastVisible(t = cursor.tick()): boolean {
	return t % 2 === 0
}

function scheduleNext(): void {
	if (!onChange) return
	const now = Date.now()
	const nextHeartbeat = Math.floor(now / HEARTBEAT_MS) + 1
	timer = setTimeout(() => {
		onChange?.(nextHeartbeat % 3 === 0, nextHeartbeat % 2 === 0)
		cursor.scheduleNext()
	}, Math.max(1, nextHeartbeat * HEARTBEAT_MS - now))
}

function start(onPhaseChange: (cursorFrame: boolean, toolFrame: boolean) => void): void {
	cursor.stop()
	onChange = onPhaseChange
	cursor.scheduleNext()
}

function stop(): void {
	if (timer) clearTimeout(timer)
	timer = null
	onChange = null
}

export const cursor = { tick, toolTick, isVisible, isFastVisible, scheduleNext, start, stop }
