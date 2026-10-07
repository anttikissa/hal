// Model text as terminal rows (task fn): the blocks of common/markdown.ts
// drawn with SGR, links as OSC 8 with the address hidden, tables aligned
// with their cells wrapped inside their columns. Every row closes the
// styles it opens, so repainting one row never leaks into another.

import { markdown, type Block, type Links, type Run } from '../common/markdown.ts'
import { strings } from '../common/strings.ts'
import type { Style } from '../common/colors.ts'
import { diff } from '../common/diff.ts'
import { diffView } from './diff-view.ts'
import { ansi } from './ansi.ts'


// Code in the style's code color, then back to its fg; plain in a
// monochrome terminal or a style without one.
function code(text: string, style: Style | undefined): string {
	if (!style?.code || ansi.mono() || !text) return text
	return ansi.sgr({ fg: style.code }) + text + (style.fg ? ansi.sgr({ fg: style.fg }) : '\x1b[39m')
}

function styled(r: Run, text: string, style?: Style): string {
	if (r.code) text = markdownView.code(text, style)
	if (r.bold) text = `\x1b[1m${text}\x1b[22m`
	if (r.italic) text = `\x1b[3m${text}\x1b[23m`
	let href = r.href?.startsWith('/') ? ansi.webUrl(r.href) : r.href
	return href ? `\x1b]8;;${href}\x07${text}${ansi.LINK_OFF}` : text
}

// Runs wrapped to `width`: the plain text is wrapped, then each row
// takes the styles of the runs its columns came from. `keepLong`: a
// word wider than `width` keeps a row of its own (ansi.paintRows lets
// the terminal soft-wrap it); table cells break it instead.
function wrapRuns(runs: Run[], width: number, keepLong = false, style?: Style): string[] {
	let plain = runs.map((r) => r.text).join('')
	let at = 0
	return strings.wordWrap(plain, width, keepLong).map((row) => {
		let from = plain.indexOf(row, at)
		at = from + row.length
		let out = ''
		let pos = 0
		for (let r of runs) {
			let a = Math.max(from, pos)
			let b = Math.min(at, pos + r.text.length)
			if (a < b) out += markdownView.styled(r, r.text.slice(a - pos, b - pos), style)
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
			return lines.flatMap((runs) => wrapRuns(runs, x, false, style))
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

// `style`: the item's, whose fg the quieter rules and labels come back to.
function block(b: Block, width: number, style?: Style): string[] {
	if (b.type === 'table') return markdownView.table(b.rows, width, style)
	if (b.type === 'code') {
		// Fences hidden as on the web; the language, if any, shown quietly.
		let lang = b.lang ? ansi.wrap(b.lang, width).map((r) => ansi.quiet(r, style)) : []
		// The closing fence's row stays blank so a streaming reply never loses
		// a row; lines() drops the blank line after it, avoiding a double gap.
		let close = b.close === undefined ? [] : ['']
		return [...lang, ...b.lines.flatMap((l) => ansi.wrap(l, width).map((r) => b.lang === 'diff' ? diffView.paint(r, diff.tone(l), style) : markdownView.code(r, style))), ...close]
	}
	let marker = b.kind === 'quote' ? ansi.quiet('│ ', style) : b.marker
	let indent = strings.visLen(marker)
	let rows = wrapRuns(b.runs, Math.max(1, width - indent), true, style)
	return rows.map((r, i) => (i && b.kind !== 'quote' ? ' '.repeat(indent) : marker) + r)
}

// Rows of model text at `width` columns; `streaming`: it may still grow.
function lines(text: string, width: number, streaming = false, style?: Style, links?: Links): string[] {
	let source = strings.expandTabs(ansi.clean(text.replace(/\r\n?/g, '\n')))
	// While streaming, hold back an unfinished last line that is empty or may
	// still become a fence, so its row never appears and then vanishes.
	if (streaming) source = source.replace(/(^|\n)( {0,3}(`{1,2}|~{1,2}))?$/, '')
	let blocks = markdown.parse(source, streaming, links)
	let gap = (b: Block | undefined) => b?.type === 'line' && b.kind === 'p' && !b.marker && !b.runs.length
	let closed = (b: Block | undefined) => b?.type === 'code' && b.close !== undefined
	return blocks.flatMap((b, i) => (gap(b) && closed(blocks[i - 1]) ? [] : markdownView.block(b, width, style)))
}

export const markdownView = { lines, block, table, fit, styled, code }
