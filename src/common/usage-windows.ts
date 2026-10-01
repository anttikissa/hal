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

// "23:39", or "07:59 on 3 Oct" when not today.
function reset(at: string, now = Date.now()): string {
	let date = new Date(at)
	let time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
	return date.toDateString() === new Date(now).toDateString() ? time : `${time} on ${date.getDate()} ${date.toLocaleString(undefined, { month: 'short' })}`
}

export const usageWindows = { minutes, shortest, reset }
