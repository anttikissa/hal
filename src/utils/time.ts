const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad2(n: number): string {
	return String(n).padStart(2, '0')
}

function clock(date: Date): string {
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function sameLocalDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear()
		&& a.getMonth() === b.getMonth()
		&& a.getDate() === b.getDate()
}

function monthName(date: Date): string {
	return MONTHS[date.getMonth()] ?? ''
}

function formatTimestamp(ts?: number, now = Date.now()): string {
	if (!ts) return ''
	const date = new Date(ts)
	if (sameLocalDay(date, new Date(now))) return clock(date)
	return `${date.getDate()} ${monthName(date)} ${clock(date)}`
}

function formatDatedTimestamp(date: Date): string {
	return `${date.getDate()} ${monthName(date)} ${clock(date)}`
}

function formatTimestampRange(first?: number, last?: number, now = Date.now()): string {
	const start = first ? new Date(first) : null
	const end = last ? new Date(last) : null
	if (!start) return ''
	if (!end || first === last) return formatTimestamp(first, now)
	if (!sameLocalDay(start, end)) return `${formatDatedTimestamp(start)} - ${formatDatedTimestamp(end)}`
	const startText = formatTimestamp(first, now)
	const endText = clock(end)
	if (startText === endText) return startText
	return `${startText} - ${endText}`
}

function formatDateTime(ts: number): string {
	const date = new Date(ts)
	return `${date.getDate()} ${monthName(date)} ${date.getFullYear()}, ${clock(date)}`
}

function unit(value: number, word: string): string {
	return `${value} ${word}${value === 1 ? '' : 's'}`
}

function formatAge(ms: number): string {
	const totalHours = Math.max(0, Math.floor(ms / (60 * 60 * 1000)))
	const days = Math.floor(totalHours / 24)
	const hours = totalHours % 24
	if (days >= 3) return `${unit(days, 'day')} ago`
	if (days > 0 && hours > 0) return `${unit(days, 'day')} ${unit(hours, 'hour')} ago`
	if (days > 0) return `${unit(days, 'day')} ago`
	return `${unit(Math.max(1, totalHours), 'hour')} ago`
}

function formatLastActiveNotice(ts: number, now = Date.now()): string {
	return `This session was last active ${formatDateTime(ts)} (${formatAge(now - ts)})`
}

export const time = {
	formatTimestamp,
	formatTimestampRange,
	formatDateTime,
	formatAge,
	formatLastActiveNotice,
}
