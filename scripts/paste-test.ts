// Paste test: verifies bracketed paste mode works
const { stdin, stdout } = process
stdin.setRawMode(true)
stdin.setEncoding('utf8')
stdout.write('\x1b[?2004h') // enable bracketed paste

stdout.write('Paste something and press q to quit:\r\n')

stdin.on('data', (data: string) => {
	const hex = [...data].map(c => {
		const code = c.charCodeAt(0)
		if (code < 0x20 || code === 0x7f) return `\\x${code.toString(16).padStart(2, '0')}`
		return c
	}).join('')
	stdout.write(`[${data.length} chars] ${hex}\r\n`)
	if (data === 'q') {
		stdout.write('\x1b[?2004l') // disable
		process.exit(0)
	}
})
