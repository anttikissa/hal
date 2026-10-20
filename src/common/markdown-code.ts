// Lets callers find controls in prose while ignoring code: a view of the
// text at the same length, with literal code masked out. Markdown
// rendering need not know what the controls mean.
function mask(text: string): string {
	let fence: { marker: string; size: number } | undefined
	return text
		.split('\n')
		.map((line) => {
			let opening = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
			if (fence) {
				if (opening && opening[1]![0] === fence.marker && opening[1]!.length >= fence.size && !opening[2]!.trim())
					fence = undefined
				return ' '.repeat(line.length)
			}
			if (opening) {
				fence = { marker: opening[1]![0]!, size: opening[1]!.length }
				return ' '.repeat(line.length)
			}
			let out = ''
			for (let i = 0; i < line.length;) {
				if (line[i] === '\\' && line[i + 1]) {
					out += line.slice(i, i + 2)
					i += 2
				} else if (line[i] === '`') {
					let size = /^`+/.exec(line.slice(i))![0].length
					let end = line.length
					for (let match of line.slice(i + size).matchAll(/`+/g)) {
						if (match[0].length === size) {
							end = i + size + match.index + size
							break
						}
					}
					// Protect an unfinished span too: its contents are literal
					// while streaming, just as an unfinished fenced block is.
					out += ' '.repeat(end - i)
					i = end
				} else out += line[i++]
			}
			return out
		})
		.join('\n')
}

export const markdownCode = { mask }
