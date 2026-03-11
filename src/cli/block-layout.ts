// Low-level layout primitives for block rendering.

import * as colors from './colors.ts'
import { strings } from '../utils/strings.ts'
import { state } from '../state.ts'

export const TOOL_MAX_OUTPUT = 5
export const THINKING_BLOCK_MIN_LINES = 5
export const THINKING_BLOCK_MAX_LINES = 10
export const BLOCK_MARGIN = 1
export const BLOCK_PAD = 1
const TAB_WIDTH = 4

/** Collapse runs of 3+ newlines to 2 (preserving paragraph breaks). */
export function collapseBlankLines(text: string): string {
	return text.replace(/\n{3,}/g, '\n\n')
}

export function oneLine(text: string): string {
	return text.replace(/\s*\r?\n+\s*/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Expand tabs to spaces (tab stops at TAB_WIDTH columns). */
export function expandTabs(s: string): string {
	let col = 0
	let out = ''
	for (const ch of s) {
		if (ch === '\t') {
			const spaces = TAB_WIDTH - (col % TAB_WIDTH)
			out += ' '.repeat(spaces)
			col += spaces
		} else {
			out += ch
			col++
		}
	}
	return out
}

export function innerWidth(width: number): number {
	return Math.max(1, width - 2 * BLOCK_MARGIN)
}

export function contentWidth(width: number): number {
	return Math.max(1, innerWidth(width) - 2 * BLOCK_PAD)
}

export function clipAnsi(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return ''
	if (strings.visLen(text) <= maxWidth) return text
	if (maxWidth === 1) return '…'
	const limit = maxWidth - 1
	let out = ''
	let vis = 0
	let esc = false
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		if (ch === '\x1b') {
			esc = true
			out += ch
			continue
		}
		if (esc) {
			out += ch
			if (ch === 'm') esc = false
			continue
		}
		const cp = text.codePointAt(i)!
		const cl = cp > 0xffff ? 2 : 1
		const w = strings.charWidth(cp)
		if (vis + w > limit) break
		out += text.slice(i, i + cl)
		vis += w
		if (cl === 2) i++
	}
	return out + '…'
}

export function clipPlain(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return ''
	if (text.length <= maxWidth) return text
	if (maxWidth === 1) return '…'
	return text.slice(0, maxWidth - 1) + '…'
}

export function boxLine(text: string, width: number, fg: string, bg: string): string {
	const iw = innerWidth(width)
	const raw = ' '.repeat(BLOCK_PAD) + expandTabs(text.replace(/\r/g, ''))
	const clipped = clipAnsi(raw, iw)
	const pad = Math.max(0, iw - strings.visLen(clipped))
	return `${' '.repeat(BLOCK_MARGIN)}${bg}${fg}${clipped}${' '.repeat(pad)}${colors.RESET}${' '.repeat(BLOCK_MARGIN)}`
}

export function plainLine(text: string, width: number, fg: string): string {
	const iw = innerWidth(width)
	const clipped = clipAnsi(expandTabs(text.replace(/\r/g, '')), iw)
	const pad = Math.max(0, iw - strings.visLen(clipped))
	return `${' '.repeat(BLOCK_MARGIN)}${fg}${clipped}${' '.repeat(pad)}${colors.RESET}${' '.repeat(BLOCK_MARGIN)}`
}

function headerLine(text: string, width: number, fg: string, bg: string): string {
	const iw = innerWidth(width)
	const vw = strings.visLen(text)
	const pad = Math.max(0, iw - vw)
	return `${' '.repeat(BLOCK_MARGIN)}${bg}${fg}${text}${' '.repeat(pad)}${colors.RESET}${' '.repeat(BLOCK_MARGIN)}`
}

export function toolHeader(label: string, width: number, fg: string, bg: string, blobId: string | undefined, sessionId = ''): string[] {
	const iw = innerWidth(width)
	const safeLabel = oneLine(label)
	const displayBlobId = blobId ? (sessionId ? `${sessionId}/${blobId}` : blobId) : ''
	const safeBlobId = displayBlobId ? clipPlain(oneLine(displayBlobId), 24) : ''
	let blobDisplay = ''
	if (safeBlobId && blobId) {
		const fileUrl = `file://${state.blobsDir(sessionId)}/${blobId}.ason`
		blobDisplay = ` [\x1b]8;;${fileUrl}\x07${safeBlobId}\x1b]8;;\x07] ──`
	}
	const prefix = '── '
	const maxLabel = Math.max(1, iw - prefix.length - (safeBlobId ? safeBlobId.length + 6 : 0) - 2)
	const shown = clipPlain(safeLabel, maxLabel)
	const lead = `${prefix}${shown} `
	const fill = '─'.repeat(Math.max(1, iw - lead.length - (safeBlobId ? safeBlobId.length + 6 : 0)))
	return [headerLine(lead + fill + blobDisplay, width, fg, bg)]
}

export function elapsed(startTime: number, endTime?: number): string {
	const s = ((endTime ?? Date.now()) - startTime) / 1000
	return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`
}

export const blockLayout = {
	collapseBlankLines, oneLine, expandTabs, innerWidth, contentWidth,
	clipAnsi, clipPlain, boxLine, plainLine, toolHeader, elapsed,
}
