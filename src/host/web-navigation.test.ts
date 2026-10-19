// Browser tests of addresses and loading: earlier history, block and
// queued-message addresses, and Find.

import { expect } from 'bun:test'
import type { Event } from '../common/protocol.ts'
import { blobs } from './blobs.ts'
import { history } from './history.ts'
import { pages } from './pages.ts'
import { tabs } from './tabs.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'
import { useWeb, base, cookie, until } from './web-fixture.test.ts'
import { browser, browserTest, useChrome } from './web-chrome-fixture.test.ts'

useWeb()
useChrome()

browserTest(
	'in a browser earlier history loads above: shown cards stay, open ones stay open',
	async () => {
		// Turns taller than the window, one per page.
		let id = tabs.create('/tmp')
		for (let t = 0; t < 4; t++) {
			history.append(id, { type: 'user', blocks: [{ type: 'text', text: `prompt ${t}` }] })
			history.append(id, { type: 'assistant', block: { type: 'thinking', text: `thought ${t}` } })
			history.append(id, { type: 'assistant', block: { type: 'text', text: `reply ${t}\n`.repeat(80) } })
			history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
		}
		pages.budget = 1500
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Emulation.setDeviceMetricsOverride', {
				width: 1200,
				height: 800,
				deviceScaleFactor: 1,
				mobile: false,
			})
			await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
			await b.call('Page.navigate', { url: `${base()}/${id}` })
			await b.waitFor(
				`document.querySelector('main')?.innerText.includes('thought 3') && !document.querySelector('main')?.innerText.includes('prompt 0')`,
			)
			// Open the newest thinking card, then read up to the top until the
			// first prompt has arrived.
			await b.evaluate(`[...document.querySelectorAll('.Card.thinking')].at(-1).click()`)
			await b.waitFor(`[...document.querySelectorAll('.Card.thinking')].at(-1).classList.contains('open')`)
			let loaded = await b.evaluate(`(async () => {
			let main = document.querySelector('main'), cards = [...document.querySelectorAll('.Card')], added = 0
			let open = cards.filter((c) => c.matches('.thinking.open'))
			let seen = new MutationObserver((ms) => { for (let m of ms) for (let n of m.addedNodes) if (n.nodeType === 1 && (n.matches('.Card') || n.querySelector('.Card'))) added++ })
			seen.observe(main, { childList: true, subtree: true })
			for (let i = 0; i < 200 && !main.innerText.includes('prompt 0'); i++) {
				main.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
				main.scrollTop = 0
				main.dispatchEvent(new Event('scroll'))
				await new Promise((r) => setTimeout(r, 20))
			}
			seen.disconnect()
			let now = [...document.querySelectorAll('.Card')]
			return {
				kept: cards.every((c) => c.isConnected),
				stillOpen: open.length === 1 && open[0].classList.contains('open'),
				opened: now.filter((c) => c.matches('.thinking.open')).length,
				grew: now.length - cards.length === added && added > 0,
				first: main.innerText.includes('prompt 0'),
			}
		})()`)
			expect(loaded).toEqual({ kept: true, stillOpen: true, opened: 1, grew: true, first: true })
		} finally {
			await b.close()
		}
	},
	20000,
)

browserTest(
	'in a browser a block address loads its page, marks its card and opens the whole output',
	async () => {
		// The linked tool result sits in the first turn, pages away from the tail.
		let id = tabs.create('/tmp')
		let output = Array.from({ length: 40 }, (_, i) => `row ${i + 1}`).join('\n')
		let { blob } = blobs.store(id, 'image/gif', 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
		history.append(id, {
			type: 'user',
			blocks: [
				{ type: 'text', text: 'prompt 0' },
				{ type: 'image', blob, mediaType: 'image/gif' },
			],
		})
		history.append(id, {
			type: 'assistant',
			block: {
				type: 'tool_call',
				id: 'c0',
				name: 'bash',
				input: {
					command: 'seq 40\nprintf done',
					modifies: ['/tmp/example.log'],
					timeout: 120000,
					background: false,
					unfamiliar: { explanation: 'Keep this visible' },
				},
			},
		})
		let result = history.append(id, { type: 'user', blocks: [{ type: 'tool_result', id: 'c0', output }] })
		history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
		for (let t = 1; t < 4; t++) {
			history.append(id, { type: 'user', blocks: [{ type: 'text', text: `prompt ${t}` }] })
			history.append(id, { type: 'assistant', block: { type: 'text', text: `reply ${t}\n`.repeat(80) } })
			history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
		}
		pages.budget = 1500
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Emulation.setDeviceMetricsOverride', {
				width: 1200,
				height: 800,
				deviceScaleFactor: 1,
				mobile: false,
			})
			await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
			await b.call('Page.navigate', { url: `${base()}/${id}#${result.n}` })
			await b.waitFor(`!!document.querySelector('.Card.target.open')?.innerText.includes('row 40')`)
			let seen = await b.evaluate(`(() => {
			let card = document.querySelector('.Card.target'), box = card.getBoundingClientRect(), main = document.querySelector('main').getBoundingClientRect()
			let link = card.querySelector('a.link')
			return { targets: document.querySelectorAll('.Card.target').length, visible: box.top < main.bottom && box.bottom > main.top, link: link && new URL(link.href).pathname + new URL(link.href).hash }
		})()`)
			expect(seen).toEqual({ targets: 1, visible: true, link: `/${id}#t${result.n! - 1}` })
			let inspection = await b.evaluate(`document.querySelector('.Card.target .contents').textContent`)
			expect(inspection).toContain('seq 40\nprintf done\nEdits /tmp/example.log')
			expect(inspection).toContain('Keep this visible')
			expect(inspection).not.toMatch(/\bc0\b|120000|Call ID/)
			// It flashes; scrolled out of view, the address drops its #block.
			expect(await b.evaluate(`document.querySelector('.Card.target').getAnimations().length`)).toBe(1)
			await b.evaluate(
				`(() => { let t = document.querySelector('.Transcript'); t.dispatchEvent(new WheelEvent('wheel', { deltaY: 1000, bubbles: true })); t.scrollTop = 1e6 })()`,
			)
			await b.waitFor(`!location.hash && !document.querySelector('.Card.target')`)
		} finally {
			await b.close()
		}
	},
	20000,
)

browserTest(
	'in a browser a queued message address shows its card at the bottom',
	async () => {
		// The reveal's scroll event may come after a resize; the view must not
		// go back to the pre-reveal reading anchor (the top).
		let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
		for (let t = 0; t < 12; t++) {
			history.append(id, { type: 'user', blocks: [{ type: 'text', text: `prompt ${t}` }] })
			history.append(id, { type: 'assistant', block: { type: 'text', text: `reply ${t}\n\nmore` } })
		}
		let queued = history.append(id, { type: 'inbox', id: 'q1', text: 'Queued one', delivery: 'after-turn' })
		history.append(id, { type: 'assistant', block: { type: 'text', text: 'still working' } })
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Emulation.setDeviceMetricsOverride', {
				width: 1000,
				height: 600,
				deviceScaleFactor: 1,
				mobile: false,
			})
			await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}#u${queued.n}` })
			await b.waitFor(`document.querySelector('.Card.target.queued')`)
			await Bun.sleep(300)
			let box = await b.evaluate(
				`(() => { let c = document.querySelector('.Card.target').getBoundingClientRect(), m = document.querySelector('.Transcript').getBoundingClientRect(); return c.top >= m.top && c.bottom <= m.bottom })()`,
			)
			expect(box).toBe(true)
		} finally {
			await b.close()
		}
	},
	20000,
)

browserTest('Find keeps focus stable while results arrive and filters take focus', async () => {
	let id = tabs.create('/tmp')
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'findneedle' }] })
	history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
		await b.waitFor(`document.querySelector('main')?.innerText.includes('findneedle')`)
		await b.call('Input.dispatchKeyEvent', {
			type: 'keyDown',
			key: 'f',
			code: 'KeyF',
			windowsVirtualKeyCode: 70,
			modifiers: 2,
		})
		await b.waitFor(`document.querySelector('.Picker[open] .input') === document.activeElement`)
		await b.call('Input.insertText', { text: 'findneedle' })
		await b.waitFor(`document.querySelector('.Picker .blocks-hint')?.textContent.startsWith('Showing 1 result')`)
		await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown' })
		await b.waitFor(`document.activeElement === document.querySelector('.Picker .filters button')`)
		await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight' })
		await b.waitFor(`document.activeElement === document.querySelectorAll('.Picker .filters button')[1]`)
		await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ' })
		await b.waitFor(`document.querySelectorAll('.Picker .filters button')[1].getAttribute('aria-pressed') === 'false'`)
		await b.waitFor(`document.querySelector('.Picker .blocks-hint')?.textContent.startsWith('Showing 1 result')`)
		expect(await b.evaluate(`document.activeElement === document.querySelectorAll('.Picker .filters button')[1]`)).toBe(
			true,
		)
		await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown' })
		await b.waitFor(`document.activeElement === document.querySelector('.Picker ul')`)
		await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp' })
		await b.waitFor(`document.activeElement === document.querySelector('.Picker .filters button')`)
		await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown' })
		await b.waitFor(`document.activeElement === document.querySelector('.Picker ul')`)
		await b.evaluate(`document.querySelector('.Picker li a').click()`)
		await b.waitFor(`!document.querySelector('.Picker[open]') && !!location.hash`)
		await b.call('Input.dispatchKeyEvent', {
			type: 'keyDown',
			key: 'f',
			code: 'KeyF',
			windowsVirtualKeyCode: 70,
			modifiers: 2,
		})
		await b.waitFor(`document.querySelector('.Picker[open]')`)
		await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' })
		await b.waitFor(`!document.querySelector('.Picker[open]')`)
	} finally {
		await b.close()
	}
})
