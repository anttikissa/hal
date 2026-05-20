const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

function pad2(n: number): string {
	return String(n).padStart(2, '0')
}

function clock(date: Date): string {
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function monthName(date: Date): string {
	return MONTHS[date.getMonth()] ?? ''
}

function monthDay(date: Date): string {
	return `${date.getDate()} ${monthName(date)}`
}

function monthDayClock(date: Date): string {
	return `${monthDay(date)} ${clock(date)}`
}

function sameLocalDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear()
		&& a.getMonth() === b.getMonth()
		&& a.getDate() === b.getDate()
}

function parsedDate(ts?: string): Date | null {
	if (!ts) return null
	const date = new Date(ts)
	if (isNaN(date.getTime())) return null
	return date
}

function unit(value: number, word: string): string {
	return `${value} ${word}${value === 1 ? '' : 's'}`
}

function formatTimestamp(ts?: number, now = Date.now()): string {
	if (!ts) return ''
	const date = new Date(ts)
	if (sameLocalDay(date, new Date(now))) return clock(date)
	return monthDayClock(date)
}

function formatTimestampRange(first?: number, last?: number, now = Date.now()): string {
	const start = first ? new Date(first) : null
	const end = last ? new Date(last) : null
	if (!start) return ''
	if (!end || first === last) return formatTimestamp(first, now)
	if (!sameLocalDay(start, end)) return `${monthDayClock(start)} - ${monthDayClock(end)}`
	const startText = formatTimestamp(first, now)
	const endText = clock(end)
	if (startText === endText) return startText
	return `${startText} - ${endText}`
}

function formatDateTime(ts: number): string {
	const date = new Date(ts)
	return `${monthDay(date)} ${date.getFullYear()}, ${clock(date)}`
}

function formatLocalDateTime(ts?: string): string | null {
	const date = parsedDate(ts)
	return date ? monthDayClock(date) : null
}

function formatAge(ms: number): string {
	const totalHours = Math.max(0, Math.floor(ms / HOUR_MS))
	const days = Math.floor(totalHours / 24)
	const hours = totalHours % 24
	if (days >= 3) return `${unit(days, 'day')} ago`
	if (days > 0 && hours > 0) return `${unit(days, 'day')} ${unit(hours, 'hour')} ago`
	if (days > 0) return `${unit(days, 'day')} ago`
	return `${unit(Math.max(1, totalHours), 'hour')} ago`
}

function formatShortAge(ms: number): string {
	if (ms >= 2 * DAY_MS) return `${Math.round(ms / DAY_MS)} days ago`
	if (ms >= DAY_MS) return 'yesterday'
	if (ms >= HOUR_MS) return `${Math.round(ms / HOUR_MS)}h ago`
	if (ms >= MINUTE_MS) return `${Math.round(ms / MINUTE_MS)}m ago`
	return 'just now'
}

function formatLastActiveNotice(ts: number, now = Date.now()): string {
	return `This session was last active ${formatDateTime(ts)} (${formatAge(now - ts)})`
}

function formatResetAt(resetAtMs: number, now = new Date()): string {
	const date = new Date(resetAtMs)
	const text = clock(date)
	if (sameLocalDay(date, now)) return text
	return `${text} on ${monthDay(date)}`
}

function formatSystemDate(date = new Date()): string {
	const day = date.toLocaleDateString('en-US', { weekday: 'long' })
	return `${date.toISOString().slice(0, 10)}, ${day}`
}

function formatQuotaWindow(minutes: number): string {
	if (minutes > 0 && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`
	if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}h`
	return `${minutes}m`
}

function formatFutureDistance(targetMs: number, nowMs = Date.now()): string {
	const ms = Math.max(0, targetMs - nowMs)
	if (ms < MINUTE_MS) return 'real soon now'
	if (ms < HOUR_MS) return `in ${unit(Math.max(1, Math.round(ms / MINUTE_MS)), 'minute')}`
	const hours = Math.max(1, Math.round((ms / HOUR_MS) * 10) / 10)
	return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

export const time = {
	formatTimestamp,
	formatTimestampRange,
	formatDateTime,
	formatLocalDateTime,
	formatAge,
	formatShortAge,
	formatLastActiveNotice,
	formatResetAt,
	formatSystemDate,
	formatQuotaWindow,
	formatFutureDistance,
}
