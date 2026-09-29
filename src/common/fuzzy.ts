// Fuzzy matching of typed words against text, shared by the model
// picker and later the find modal (task zg): which texts match and how
// well, and where the words show so clients can highlight them.

// Lowercase words, split at anything not a letter or digit and between
// letters and digits: "Opus-5.5" and "opus5 5" are both opus, 5, 5.
function words(s: string): string[] {
	return s.toLowerCase().match(/[a-z]+|[0-9]+/g) ?? []
}

// How well `id` matches the query words, or undefined if it does not:
// each word must appear, in order, preferably where a word of the id
// starts. Whole words and words right after the previous match score
// higher, so "opus-5.5" prefers claude-opus-5-5 to claude-opus-5-15.
function score(id: string, query: string[]): number | undefined {
	let parts = words(id)
	let text = parts.join(' ')
	let starts = new Set<number>()
	let at = 0
	for (let p of parts) {
		starts.add(at)
		at += p.length + 1
	}
	let total = 0
	let pos = 0
	let lastEnd = -1
	for (let q of query) {
		let found = -1
		for (let i = text.indexOf(q, pos); i >= 0; i = text.indexOf(q, i + 1)) {
			if (found < 0) found = i
			if (starts.has(i)) {
				found = i
				break
			}
		}
		if (found < 0) return undefined
		let end = found + q.length
		if (starts.has(found)) total += 2
		if (starts.has(found) && (end === text.length || text[end] === ' ')) total += 1
		if (lastEnd >= 0 && found === lastEnd + 1) total += 3
		lastEnd = end
		pos = end
	}
	return total
}

// Where `query`'s words show in `text`, to highlight them: [start, end)
// ranges, sorted and merged. A word counts where a word of the text
// starts (the "5" of "5.6", not of "15"), anywhere only if it starts
// nowhere; a word found nowhere marks nothing.
function marks(text: string, query: string): [number, number][] {
	let lower = text.toLowerCase()
	let kind = (c: string | undefined) => (c === undefined ? '' : /[a-z]/.test(c) ? 'a' : /[0-9]/.test(c) ? '0' : '')
	let found: [number, number][] = []
	for (let q of words(query)) {
		let at: number[] = []
		for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + 1)) at.push(i)
		let starts = at.filter((i) => kind(lower[i - 1]) !== kind(q[0]))
		for (let i of starts.length ? starts : at) found.push([i, i + q.length])
	}
	found.sort((x, y) => x[0] - y[0])
	let out: [number, number][] = []
	for (let r of found) {
		let last = out[out.length - 1]
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
		else out.push([r[0], r[1]])
	}
	return out
}

export const fuzzy = { words, score, marks }
