// Subscription usage windows as clients show them (tasks ab, 5f): the
// shortest window, which the web's model name fills by, and a reset
// time in 24-hour local time, with the day when it is not today.

// A window's length in minutes from its name (5h, 7d, 300m); none for
// a name without one (primary).
function minutes(name: string): number | undefined {
	let m = /^(\d+)([mhdw])$/.exec(name)
	return m ? Number(m[1]) * { m: 1, h: 60, d: 1440, w: 10080 }[m[2] as 'm' | 'h' | 'd' | 'w'] : undefined
}

// The shortest window by duration, normally 5h; names without a length
// come last, in their order.
function shortest(windows: Record<string, number>): string | undefined {
	let names = Object.keys(windows)
	let length = (name: string) => usageWindows.minutes(name) ?? Infinity
	return names.reduce<string | undefined>((best, name) => (best === undefined || length(name) < length(best) ? name : best), undefined)
}

// "23:39", or "07:59 on 3 Oct" when not today, in timeZone (default local).
function reset(at: string, now = Date.now(), timeZone?: string): string {
	let date = new Date(at)
	let time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone })
	let day = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone })
	return day(date) === day(new Date(now)) ? time : `${time} on ${day(date)}`
}

// Windows that cannot bind: another window is full until at least as
// late (a full 7d makes the 5h moot). Shown quietly, not as quota.
function moot(windows: { name: string; used: number; resets?: string }[]): Set<string> {
	let end = (w: { resets?: string }) => (w.resets ? Date.parse(w.resets) : Infinity)
	return new Set(windows.filter((w) => windows.some((o) => o !== w && o.used >= 100 && end(o) >= end(w))).map((w) => w.name))
}

export const usageWindows = { minutes, shortest, reset, moot }
