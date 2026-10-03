import { expect, test } from 'bun:test'
import { settings } from '../common/settings.ts'
import { itemView } from './item-view.ts'

test('an image block’s label links to the image', () => {
	let item = { type: 'image', blob: 'abc123def456', mediaType: 'image/png', bytes: 27000, key: '~0' } as const
	let url = `http://localhost:${settings.webPort()}/blob/s-1/abc123def456`
	expect(itemView.itemLines(item as any, 60, false, 's-1')).toEqual([`\x1b]8;;${url}\x07[image 27 kB png]\x1b]8;;\x07`])
	expect(itemView.itemLines(item as any, 60)).toEqual(['[image 27 kB png]'])
})
