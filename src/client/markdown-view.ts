// Model text as terminal rows (task fn): the blocks of common/markdown.ts
// drawn with SGR, links as OSC 8 with the address hidden, tables aligned
// with their cells wrapped inside their columns. Every row closes the
// styles it opens, so repainting one row never leaks into another.

import { markdown, type Block, type Run } from '../common/markdown.ts'
import { strings } from '../common/strings.ts'
import type { Style } from '../common/colors.ts'
import { ansi } from './ansi.ts'


function styled(r: Run, text: string): string {
	if (r.bold) text = `\x1b[1m${text}\x1b[22m`
	if (r.italic) text = `\x1b[3m${text}\x1b[23m`
	return r.href ? `\x1b]8;;${r.href}\x07${text}${ansi.LINK_OFF}` : text
}

// Runs wrapped to `width`: the plain text is wrapped, then each row
// takes the styles of the runs its columns came from.
function wrapRuns(runs: Run[], width: number): string[] {
	let plain = runs.map((r) => r.text).join('')
	let at = 0
	return strings.wordWrap(plain, width).map((row) => {
		let from = plain.indexOf(row, at)
		at = from + row.length
		let out = ''
		let pos = 0
		for (let r of runs) {
			let a = Math.max(from, pos)
			let b = Math.min(at, pos + r.text.length)
			if (a < b) out += markdownView.styled(r, r.text.slice(a - pos, b - pos))
			pos += r.text.length
		}
		return out
	})
}

// The widest word of each column is kept whole while any column can
// give up width; only then are words cut.
function fit(natural: number[], words: number[], room: number): number[] {
	let w = [...natural]
	for (let floor of [words, w.map(() => 1)]) {
		let total = w.reduce((a, b) => a + b, 0)
		while (total > room) {
			let k = w.reduce((best, _, i) => (w[i]! - floor[i]! > w[best]! - floor[best]! ? i : best), 0)
			if (w[k]! <= floor[k]!) break
			w[k]!--
			total--
		}
	}
	return w
}

function table(rows: Run[][][], width: number, style?: Style): string[] {
	let n = Math.max(...rows.map((r) => r.length))
	let plain = (c: Run[] | undefined) => (c ?? []).map((r) => r.text).join('')
	let col = (f: (s: string) => number) => Array.from({ length: n }, (_, i) => Math.max(1, ...rows.flatMap((r) => plain(r[i]).split('\n').map(f))))
	let words = col((s) => Math.max(0, ...s.split(/\s+/).map((w) => strings.visLen(w))))
	let w = markdownView.fit(col((s) => strings.visLen(s)), words, width - 3 * n - 1)
	let rule = (l: string, m: string, r: string) => ansi.quiet(l + w.map((x) => '─'.repeat(x + 2)).join(m) + r, style)
	let bar = ansi.quiet('│', style)
	let out = [rule('┌', '┬', '┐')]
	rows.forEach((row, ri) => {
		let cells = w.map((x, i) => {
			let lines: Run[][] = [[]]
			for (let r of row[i] ?? []) {
				let parts = r.text.split('\n')
				parts.forEach((text, k) => {
					if (k) lines.push([])
					if (text) lines.at(-1)!.push(ri ? { ...r, text } : { ...r, text, bold: true })
				})
			}
			return lines.flatMap((runs) => wrapRuns(runs, x))
		})
		let height = Math.max(...cells.map((c) => c.length))
		for (let k = 0; k < height; k++) {
			let parts = cells.map((c, i) => (c[k] ?? '') + ' '.repeat(w[i]! - strings.visLen(c[k] ?? '')))
			out.push(`${bar} ${parts.join(` ${bar} `)} ${bar}`)
		}
		out.push(ri < rows.length - 1 ? rule('├', '┼', '┤') : rule('└', '┴', '┘'))
	})
	return out.map((r) => strings.clipVisual(r, width))
}

// `style`: the item's, whose fg the quieter rules and fences come back to.
function block(b: Block, width: number, style?: Style): string[] {
	if (b.type === 'table') return markdownView.table(b.rows, width, style)
	if (b.type === 'code') {
		let fence = (s: string) => ansi.wrap(s, width).map((r) => ansi.quiet(r, style))
		return [...fence(b.open), ...b.lines.flatMap((l) => ansi.wrap(l, width)), ...(b.close === undefined ? [] : fence(b.close))]
	}
	let marker = b.kind === 'quote' ? ansi.quiet('│ ', style) : b.marker
	let indent = strings.visLen(marker)
	let rows = wrapRuns(b.runs, Math.max(1, width - indent))
	return rows.map((r, i) => (i && b.kind !== 'quote' ? ' '.repeat(indent) : marker) + r)
}

// Rows of model text at `width` columns; `streaming`: it may still grow.
function lines(text: string, width: number, streaming = false, style?: Style): string[] {
	let source = strings.expandTabs(ansi.clean(text.replace(/\r\n?/g, '\n')))
	return markdown.parse(source, streaming).flatMap((b) => markdownView.block(b, width, style))
}

export const markdownView = { lines, block, table, fit, styled }
