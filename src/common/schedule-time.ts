// Parses saved job timing and finds real instants in the user's timezone.
export type Timing = { every: number } | { minutes: number[]; weekdays?: number[] }

function duration(text: string): number {
	let m = /^(?:every\s+)?(?:(\d+)\s*)?(m|min|minutes?|h|hours?|d|days?)$/.exec(text.trim().toLowerCase())
	let n = m && Number(m[1] ?? 1) * (m[2]!.startsWith('h') ? 60 : m[2]!.startsWith('d') ? 1440 : 1)
	if (!n || !Number.isSafeInteger(n) || n > 525600)
		throw new Error(`Invalid duration: ${text}; use 30m or every hour (up to 365 days).`)
	return n * 60000
}

function minute(text: string): number {
	let m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
	if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Invalid clock time: ${text}`)
	return Number(m[1]) * 60 + Number(m[2])
}

function parse(text: string): Timing {
	let s = text
		.trim()
		.toLowerCase()
		.replace(/…|\.{3,}/g, '..')
		.replace(/\s+/g, ' ')
	if (/^(?:every )?(?:\d+\s*)?(?:m|min|minutes?|h|hours?|d|days?)$/.test(s)) return { every: scheduleTime.duration(s) }
	let hourly = /^(?:hourly(?: at)?|every hour(?: at)?|every)\s*:(\d{2})$/.exec(s)
	if (hourly) {
		let n = Number(hourly[1])
		if (n > 59) throw new Error(`Invalid hourly minute: ${text}`)
		return { minutes: Array.from({ length: 24 }, (_, h) => h * 60 + n) }
	}
	let days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
	let day = /^(?:every )?([a-z]+(?:\s*[-–]\s*[a-z]+)?)(?: at)? (?=\d)/.exec(s)
	let weekdays: number[] | undefined
	if (day && !['daily', 'day', 'at'].includes(day[1]!)) {
		let ends = day[1]!.split(/\s*[-–]\s*/).map((word) => days.findIndex((d) => d === word || d.slice(0, 3) === word))
		if (ends.some((n) => n < 0)) throw new Error(`Invalid weekday: ${day[1]}`)
		weekdays = [ends[0]!]
		while (weekdays.at(-1) !== ends.at(-1)) weekdays.push((weekdays.at(-1)! + 1) % 7)
		s = s.slice(day[0].length)
	} else s = s.replace(/^(?:daily|every day)(?: at)? /, '').replace(/^at /, '')
	let range = /^(\d{1,2}:\d{2})\s*\.\.\s*(\d{1,2}:\d{2})(?: every (.+))?$/.exec(s)
	let minutes: number[]
	if (range) {
		let first = scheduleTime.minute(range[1]!),
			last = scheduleTime.minute(range[2]!)
		let step = scheduleTime.duration(range[3] ?? '1h') / 60000
		if (first > last) throw new Error('A daily range must end at or after its start.')
		minutes = []
		for (let n = first; n <= last; n += step) minutes.push(n)
	} else minutes = s.split(/\s*,\s*|\s+and\s+/).map(scheduleTime.minute)
	return { minutes: [...new Set(minutes)].sort((a, b) => a - b), ...(weekdays === undefined ? {} : { weekdays }) }
}

function next(timing: Timing, after: number, zone: string): number {
	if ('every' in timing) return after + timing.every
	let fmt = new Intl.DateTimeFormat('en-US', {
		timeZone: zone,
		weekday: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	})
	let wanted = new Set(timing.minutes)
	let days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
	let start = Math.floor(after / 60000) * 60000 + 60000
	for (let at = start; at < start + 16 * 86400000; at += 60000) {
		let parts = fmt.formatToParts(at)
		let value = (key: string) => parts.find((p) => p.type === key)!.value
		if (
			wanted.has(Number(value('hour')) * 60 + Number(value('minute'))) &&
			(timing.weekdays === undefined || timing.weekdays.includes(days.indexOf(value('weekday'))))
		)
			return at
	}
	throw new Error('No schedule occurrence within sixteen days.')
}

export const scheduleTime = { duration, minute, parse, next }
