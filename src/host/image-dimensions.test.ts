import { test, expect } from 'bun:test'

// Run the reader as the page does: a broken/truncated file must not
// prevent the page itself from opening.
function read(type: string, hex: string): string {
	let result = Bun.spawnSync([process.execPath, `${import.meta.dir}/../../scripts/image-dimensions.ts`, type], { stdin: Buffer.from(hex, 'hex') })
	expect(result.exitCode).toBe(0)
	return result.stdout.toString().trim()
}

test('reads PNG, GIF, JPEG and both WebP frame headers; truncated input has no resolution', () => {
	expect(read('image/png', '89504e470d0a1a0a0000000d4948445200000138000000d8')).toBe('312 × 216')
	expect(read('image/gif', '47494638396140018002')).toBe('320 × 640')
	expect(read('image/jpeg', 'ffd8ffe000044a4affc000110800d8013803011100021101031101ffda')).toBe('312 × 216')
	expect(read('image/webp', '524946461600000057454250565038580a000000000000003f0100d70200')).toBe('320 × 728')
	expect(read('image/webp', '524946461800000057454250565038200a0000000000009d012a4001d800')).toBe('320 × 216')
	expect(read('image/webp', '5249464618000000574542505650384c050000002f3fc13500')).toBe('320 × 216')
	expect(read('image/jpeg', 'ffd8ffc0000708')).toBe('')
})
