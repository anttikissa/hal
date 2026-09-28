// On-demand image header reader, run by file-page only when opening an
// image page. Nothing under src imports it at host startup.

// Dimensions from image headers. Invalid or truncated files simply omit the
// dimensions; the browser still displays the original bytes at /raw/.
function dimensions(bytes: Buffer, type: string): string | undefined {
	let w: number | undefined, h: number | undefined
	if (type === 'image/png' && bytes.length >= 24 && bytes.toString('ascii', 12, 16) === 'IHDR') {
		w = bytes.readUInt32BE(16); h = bytes.readUInt32BE(20)
	} else if (type === 'image/gif' && bytes.length >= 10) {
		w = bytes.readUInt16LE(6); h = bytes.readUInt16LE(8)
	} else if (type === 'image/webp' && bytes.length >= 20) {
		let kind = bytes.toString('ascii', 12, 16)
		if (kind === 'VP8X' && bytes.length >= 30) {
			w = bytes.readUIntLE(24, 3) + 1; h = bytes.readUIntLE(27, 3) + 1
		} else if (kind === 'VP8 ' && bytes.length >= 30 && bytes.toString('hex', 23, 26) === '9d012a') {
			w = bytes.readUInt16LE(26) & 0x3fff; h = bytes.readUInt16LE(28) & 0x3fff
		} else if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
			w = 1 + (((bytes[22]! & 0x3f) << 8) | bytes[21]!)
			h = 1 + (((bytes[24]! & 0x0f) << 10) | (bytes[23]! << 2) | (bytes[22]! >> 6))
		}
	} else if (type === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		for (let i = 2; i + 4 <= bytes.length;) {
			if (bytes[i++] !== 0xff) break
			while (bytes[i] === 0xff) i++
			let marker = bytes[i++]
			if (marker === undefined || marker === 0xda || marker === 0xd9) break
			if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
			if (i + 2 > bytes.length) break
			let len = bytes.readUInt16BE(i)
			if (len < 2 || i + len > bytes.length) break
			if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && len >= 7) {
				h = bytes.readUInt16BE(i + 3); w = bytes.readUInt16BE(i + 5); break
			}
			i += len
		}
	}
	return w && h ? `${w} × ${h}` : undefined
}

let type = process.argv[2] ?? ''
let bytes = Buffer.from(await Bun.stdin.arrayBuffer())
console.log(dimensions(bytes, type) ?? '')
