// In-memory line-number remapping for the edit tool.
//
// The model often keeps using line numbers from the last read even after it has
// inserted or deleted lines above the target. This tracker stores only line
// offsets per session+file so the edit tool can accept those stale line numbers
// without making the model do arithmetic.
//
// We intentionally keep this ephemeral. A fresh read resets the tracker for that
// file, and nothing is persisted to disk.

const MAX_LINE = Number.MAX_SAFE_INTEGER

interface Segment {
	kind: 'same' | 'stale'
	start: number
	end: number
	offset: number
}

interface FileLineTracker {
	segments: Segment[]
}

const state = {
	trackers: new Map<string, FileLineTracker>(),
}

function trackerKey(sessionId: string, path: string): string {
	return `${sessionId}:${path}`
}

function cloneSegment(segment: Segment): Segment {
	return { ...segment }
}

function initialTracker(): FileLineTracker {
	return {
		segments: [{ kind: 'same', start: 1, end: MAX_LINE, offset: 0 }],
	}
}

function getTracker(sessionId: string, path: string): FileLineTracker | undefined {
	return state.trackers.get(trackerKey(sessionId, path))
}

function ensureTracker(sessionId: string, path: string): FileLineTracker {
		const existing = getTracker(sessionId, path)
		if (existing) return existing
		const tracker = initialTracker()
		state.trackers.set(trackerKey(sessionId, path), tracker)
		return tracker
}

function resetForRead(sessionId: string, path: string): void {
	state.trackers.set(trackerKey(sessionId, path), initialTracker())
}

function clear(sessionId: string, path: string): void {
	state.trackers.delete(trackerKey(sessionId, path))
}

function has(sessionId: string, path: string): boolean {
	return state.trackers.has(trackerKey(sessionId, path))
}

function splitAt(segments: Segment[], line: number): Segment[] {
	if (line <= 1) return segments.map(cloneSegment)

	const result: Segment[] = []
	for (const segment of segments) {
		if (line <= segment.start || line > segment.end) {
			result.push(cloneSegment(segment))
			continue
		}
		result.push({ ...segment, end: line - 1 })
		result.push({ ...segment, start: line })
	}
	return result
}

function mergeSegments(segments: Segment[]): Segment[] {
	const result: Segment[] = []
	for (const segment of segments) {
		const prev = result[result.length - 1]
		if (
			prev &&
			prev.kind === segment.kind &&
			prev.offset === segment.offset &&
			prev.end + 1 === segment.start
		) {
			prev.end = segment.end
			continue
		}
		result.push(cloneSegment(segment))
	}
	return result
}

function mapBaseRangeToCurrent(sessionId: string, path: string, start: number, end: number): { startLine: number; endLine: number } | null {
	const tracker = getTracker(sessionId, path)
	if (!tracker) return null

	for (const segment of tracker.segments) {
		if (segment.kind !== 'same') continue
		if (start < segment.start || end > segment.end) continue
		return {
			startLine: start + segment.offset,
			endLine: end + segment.offset,
		}
	}

	return null
}

function mapBaseLineToCurrent(sessionId: string, path: string, line: number): number | null {
	const mapped = mapBaseRangeToCurrent(sessionId, path, line, line)
	return mapped?.startLine ?? null
}

function currentRangeForSegment(segment: Segment): { start: number; end: number } | null {
	if (segment.kind !== 'same') return null
	return {
		start: segment.start + segment.offset,
		end: segment.end + segment.offset,
	}
}

function mapCurrentRangeToBase(sessionId: string, path: string, start: number, end: number): { startLine: number; endLine: number } | null {
	const tracker = getTracker(sessionId, path)
	if (!tracker) return null

	for (const segment of tracker.segments) {
		const current = currentRangeForSegment(segment)
		if (!current) continue
		if (start < current.start || end > current.end) continue
		return {
			startLine: start - segment.offset,
			endLine: end - segment.offset,
		}
	}

	return null
}

function mapCurrentLineToBase(sessionId: string, path: string, line: number): number | null {
	const mapped = mapCurrentRangeToBase(sessionId, path, line, line)
	return mapped?.startLine ?? null
}

function applyReplace(sessionId: string, path: string, start: number, end: number, newLineCount: number): void {
	const tracker = ensureTracker(sessionId, path)
	const oldLineCount = end - start + 1
	const delta = newLineCount - oldLineCount

	let segments = splitAt(tracker.segments, start)
	segments = splitAt(segments, end + 1)

	const result: Segment[] = []
	let insertedStale = false
	for (const segment of segments) {
		if (segment.end < start) {
			result.push(segment)
			continue
		}
		if (segment.start > end) {
			if (segment.kind === 'same') segment.offset += delta
			result.push(segment)
			continue
		}
		if (!insertedStale) {
			result.push({ kind: 'stale', start, end, offset: 0 })
			insertedStale = true
		}
	}

	tracker.segments = mergeSegments(result)
}

function applyInsert(sessionId: string, path: string, afterLine: number, newLineCount: number): void {
	if (newLineCount === 0) return

	const tracker = ensureTracker(sessionId, path)
	const splitLine = afterLine + 1
	const segments = splitAt(tracker.segments, splitLine)

	for (const segment of segments) {
		if (segment.kind !== 'same') continue
		if (segment.start > afterLine) segment.offset += newLineCount
	}

	tracker.segments = mergeSegments(segments)
}

function getSegments(sessionId: string, path: string): Segment[] {
	return (getTracker(sessionId, path)?.segments ?? []).map(cloneSegment)
}

export const editTracker = {
	state,
	resetForRead,
	clear,
	has,
	mapBaseRangeToCurrent,
	mapBaseLineToCurrent,
	mapCurrentRangeToBase,
	mapCurrentLineToBase,
	applyReplace,
	applyInsert,
	getSegments,
}
