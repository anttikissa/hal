import { expect, test } from 'bun:test'
import { pasteboard } from './pasteboard.ts'

// Named pasteboards, never the user's clipboard. macOS only.
const mac = process.platform === 'darwin'

test.skipIf(!mac)('reads a PNG, or a TIFF converted to PNG, from a pasteboard', async () => {
	let png = Buffer.from(
		'89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a730000001049444154789c63f8cfc000440c100a001fee03fd8b5f14d40000000049454e44ae426082',
		'hex',
	)
	let dir = `/tmp/hal-pb-${process.pid}`
	await Bun.write(`${dir}/a.png`, png)
	let tiff = Bun.spawnSync(['sips', '-s', 'format', 'tiff', `${dir}/a.png`, '--out', `${dir}/a.tiff`])
	expect(tiff.exitCode).toBe(0)
	let put = (name: string, file: string, type: string) =>
		`var p=$.NSPasteboard.pasteboardWithName('${name}');p.clearContents;p.setDataForType($.NSData.dataWithContentsOfFile('${file}'),'${type}');`
	let js = `ObjC.import('AppKit');${put(`hal-png-${process.pid}`, `${dir}/a.png`, 'public.png')}${put(`hal-tiff-${process.pid}`, `${dir}/a.tiff`, 'public.tiff')}`
	expect(Bun.spawnSync(['osascript', '-l', 'JavaScript', '-e', js]).exitCode).toBe(0)
	expect(Buffer.from(pasteboard.png(`hal-png-${process.pid}`)!)).toEqual(png)
	let converted = pasteboard.png(`hal-tiff-${process.pid}`)!
	expect(Buffer.from(converted.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a')
	expect(pasteboard.png(`hal-empty-${process.pid}`)).toBeNull()
	Bun.spawnSync(['rm', '-rf', dir])
})
