import { expect, test } from 'bun:test'
import { attachments } from './attachments.ts'

test('markers made for a blob are found again, and only well-formed ones', () => {
	let image = attachments.marker('0123456789ab', 'image/png')
	let paste = attachments.marker('abcdef012345', 'text/plain', 1)
	let text = `a ${image} b ${paste} [image ../../x] [image 0123456789AB] [paste 0123456789ab]`
	expect(attachments.markers(text).map((m) => [m.kind, m.blob, text.slice(m.at, m.at + m.text.length)])).toEqual([
		['image', '0123456789ab', image],
		['paste', 'abcdef012345', paste],
	])
})

test('an image label rounds its size to a readable unit', () => {
	let label = (bytes?: number) => attachments.label({ mediaType: 'image/jpeg', bytes })
	expect([label(999), label(12_345), label(2_500_000), label()]).toEqual(['[image 999 B jpg]', '[image 12 kB jpg]', '[image 2.5 MB jpg]', '[image jpg]'])
})
