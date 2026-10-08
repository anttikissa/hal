// Shared diff presentation; generation belongs on the host (task k8y).
export type DiffTone = 'add' | 'del' | 'dim'
function tone(line: string): DiffTone {
	return line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'dim'
}
function fence(text: string): string {
	let length = 3
	for (let match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
	let mark = '`'.repeat(length)
	return `${mark}diff\n${text}\n${mark}`
}
// What a numbered diff (host textDiff) changed: counts, and the new file's
// changed lines, "lines 25–27, 37"; a removal alone marks the line now
// in its place (the last line when it ended the file).
function stats(text: string): { added: number; removed: number; lines: string } {
	let added = 0, removed = 0, at = 1, gone = false, marks: number[] = []
	let mark = (n: number) => { if (marks.at(-1) !== n) marks.push(n) }
	for (let row of text.split('\n')) {
		let m = /^([ +-]) *(\d+) /.exec(row)
		if (!m) continue
		let n = +m[2]!
		if (m[1] === '-') {
			removed++
			gone = true
			continue
		}
		if (m[1] === '+') added++
		if (m[1] === '+' || gone) mark(n)
		gone = false
		at = n + 1
	}
	if (gone) mark(Math.max(1, at - 1))
	let runs: string[] = []
	for (let i = 0; i < marks.length; i++) {
		let j = i
		while (marks[j + 1] === marks[j]! + 1) j++
		runs.push(j > i ? `${marks[i]}–${marks[j]}` : `${marks[i]}`)
		i = j
	}
	return { added, removed, lines: `${marks.length > 1 ? 'lines' : 'line'} ${runs.join(', ')}` }
}
export const diff = { tone, fence, stats }
