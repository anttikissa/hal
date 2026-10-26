// Shows diffs the same way in both clients: line tones, Markdown fences
// and change counts. The host makes the diffs (task k8y). A combined
// diff (git diff -c) marks each line in two columns; the second
// column's marks take their own tones, add2 and del2.
export type DiffTone = 'add' | 'del' | 'add2' | 'del2' | 'dim'
function tone(line: string, combined = false): DiffTone {
	let second = combined && line[0] === ' '
	let mark = second ? line[1] : line[0]
	let t: DiffTone = mark === '+' ? 'add' : mark === '-' ? 'del' : 'dim'
	return second && t !== 'dim' ? (`${t}2` as DiffTone) : t
}
function fence(text: string, lang = 'diff'): string {
	let length = 3
	for (let match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
	let mark = '`'.repeat(length)
	return `${mark}${lang}\n${text}\n${mark}`
}
// Whether a code fence of language `lang` is a diff, and so takes tones.
const fenced = (lang?: string) => lang === 'diff' || lang === 'combined-diff'
// What a numbered diff (host textDiff) changed: counts, and the new file's
// changed lines, "lines 25–27, 37"; a removal alone marks the line now
// in its place (the last line when it ended the file).
function stats(text: string): { added: number; removed: number; lines: string } {
	let added = 0,
		removed = 0,
		at = 1,
		gone = false,
		marks: number[] = []
	let mark = (n: number) => {
		if (marks.at(-1) !== n) marks.push(n)
	}
	for (let row of text.split('\n')) {
		let m = /^([ +-]) *(\d+)(?::)? /.exec(row)
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
export const diff = { tone, fence, fenced, stats }
