import { stdin, stdout } from 'process'

// Enable kitty keyboard protocol (progressive enhancement flags = 31)
stdout.write('\x1b[>31u')

stdin.setRawMode(true)
stdin.resume()
stdin.on('data', (buf: Buffer) => {
	const hex = [...buf].map(b => b.toString(16).padStart(2, '0')).join(' ')
	const str = buf.toString()
	const display = str.replace(/\x1b/g, 'ESC')
	console.log(`[${hex}] ${display}`)

	// Test our regex against the data
	const csiU = str.match(/^\x1b\[(\d+);(\d+)(?::(\d+))?u$/)
	if (csiU) {
		const codepoint = Number(csiU[1])
		const modifier = Number(csiU[2])
		const eventType = Number(csiU[3] ?? 1)
		const ch = String.fromCharCode(codepoint).toLowerCase()
		console.log(`  → CSI-u: codepoint=${codepoint} (${ch}) modifier=${modifier} eventType=${eventType}`)
		if (modifier >= 9 && ch === 'x') console.log('  ✓ WOULD MATCH Cmd-X handler')
		if (modifier >= 9 && ch === 'c') console.log('  ✓ WOULD MATCH Cmd-C handler')
	}
})

setTimeout(() => {
	stdout.write('\x1b[<u')
	stdin.setRawMode(false)
	process.exit(0)
}, 5000)
