import { OSC8_CLOSE, parseOsc8Uri } from './tui-links.ts'

const RESET = '\x1b[0m'

export function wordWrapLines(text: string, width: number): string[] {
	if (width <= 0) return [text]
	const result: string[] = []
	for (const segment of text.split('\n')) {
		let remaining = segment
		while (remaining.length > width) {
			let breakAt = remaining.lastIndexOf(' ', width)
			if (breakAt <= 0) breakAt = width
			result.push(remaining.slice(0, breakAt))
			remaining = remaining[breakAt] === ' ' ? remaining.slice(breakAt + 1) : remaining.slice(breakAt)
		}
		result.push(remaining)
	}
	return result
}

export function readEscapeSequence(line: string, start: number): number {
	if (line[start] !== '\x1b') return 0
	const next = line[start + 1]
	if (!next) return 1
	if (next === '[' || next === ']') {
		const isOsc = next === ']'
		for (let i = start + 2; i < line.length; i++) {
			if (isOsc) { if (line[i] === '\x07') return i - start + 1; if (line[i] === '\x1b' && line[i + 1] === '\\') return i - start + 2 }
			else { const code = line.charCodeAt(i); if (code >= 0x40 && code <= 0x7e) return i - start + 1 }
		}
		return line.length - start
	}
	return 2
}

export function truncateAnsi(line: string, maxCols: number): string {
	if (maxCols <= 0 || !line) return ''
	let out = '', visCols = 0, i = 0, sawAnsi = false, inLink = false
	while (i < line.length && visCols < maxCols) {
		if (line[i] === '\x1b') {
			const seqLen = readEscapeSequence(line, i)
			const seq = line.slice(i, i + seqLen)
			out += seq; i += seqLen; sawAnsi = true
			const uri = parseOsc8Uri(seq)
			if (uri !== null) inLink = uri.length > 0
			continue
		}
		out += line[i]; visCols++; i++
	}
	if (sawAnsi) { if (inLink) out += OSC8_CLOSE; out += RESET }
	return out
}

export function wrapAnsi(line: string, maxCols: number): string[] {
	if (maxCols <= 0 || !line) return ['']
	const result: string[] = []
	let current = '', visCols = 0, i = 0
	let activeAnsi = '', activeLink = ''
	let lastSpaceI = -1, lastSpaceCols = -1, lastSpaceCurrent = ''
	let lastSpaceAnsi = '', lastSpaceLink = ''

	const emitBreak = (text: string, link: string, ansi: string, nextI?: number) => {
		if (link) text += OSC8_CLOSE
		result.push(text + RESET)
		activeAnsi = ansi; activeLink = link
		current = activeAnsi
		if (activeLink) current += `\x1b]8;;${activeLink}\x1b\\`
		visCols = 0; if (nextI !== undefined) i = nextI
		lastSpaceI = -1; lastSpaceCols = -1
		lastSpaceCurrent = ''; lastSpaceAnsi = ''; lastSpaceLink = ''
	}

	while (i < line.length) {
		if (line[i] === '\x1b') {
			const seqLen = readEscapeSequence(line, i)
			const seq = line.slice(i, i + seqLen)
			current += seq
			if (seq.startsWith('\x1b[') && seq.endsWith('m'))
				activeAnsi = seq === '\x1b[0m' ? '' : activeAnsi + seq
			const uri = parseOsc8Uri(seq)
			if (uri !== null) activeLink = uri
			i += seqLen; continue
		}
		if (line[i] === ' ') {
			lastSpaceI = i + 1; lastSpaceCols = visCols + 1
			lastSpaceCurrent = current + ' '
			lastSpaceAnsi = activeAnsi; lastSpaceLink = activeLink
		}
		if (visCols >= maxCols) {
			if (lastSpaceCols > 0 && lastSpaceCols > maxCols * 0.3) emitBreak(lastSpaceCurrent, lastSpaceLink, lastSpaceAnsi, lastSpaceI)
			else emitBreak(current, activeLink, activeAnsi)
			continue
		}
		current += line[i]; visCols++; i++
	}
	result.push(current)
	return result
}

export function parseKeys(data: string, pasteStart: string, pasteEnd: string): string[] {
	const keys: string[] = []
	let i = 0
	while (i < data.length) {
		if (data.startsWith(pasteStart, i)) {
			const contentStart = i + pasteStart.length
			const endIdx = data.indexOf(pasteEnd, contentStart)
			if (endIdx >= 0) {
				const pasted = data.slice(contentStart, endIdx); if (pasted) keys.push(pasted)
				i = endIdx + pasteEnd.length
			} else {
				const pasted = data.slice(contentStart); if (pasted) keys.push(pasted)
				i = data.length
			}
			continue
		}
		if (data[i] === '\x1b') {
			if (i + 1 < data.length && (data[i + 1] === '[' || data[i + 1] === 'O')) {
				let j = i + 2
				while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x3f) j++
				if (j < data.length) j++
				keys.push(data.slice(i, j)); i = j
			} else if (i + 2 < data.length && data[i + 1] === '\x1b' && (data[i + 2] === '[' || data[i + 2] === 'O')) {
				let j = i + 3
				while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x3f) j++
				if (j < data.length) j++
				keys.push(data.slice(i, j)); i = j
			} else if (i + 1 < data.length) { keys.push(data.slice(i, i + 2)); i += 2 }
			else { keys.push('\x1b'); i++ }
		} else { keys.push(data[i]); i++ }
	}
	return keys
}

export function wordBoundaryLeft(buf: string, cursor: number): number {
	let i = cursor; while (i > 0 && buf[i - 1] === ' ') i--; while (i > 0 && buf[i - 1] !== ' ') i--; return i
}

export function wordBoundaryRight(buf: string, cursor: number): number {
	let i = cursor; while (i < buf.length && buf[i] !== ' ') i++; while (i < buf.length && buf[i] === ' ') i++; return i
}