// Browser test: deep history scrolls through the mounted window of
// rows without the reader's row moving, on an engine without native
// scroll anchoring (iOS Safari).

import { expect } from 'bun:test'
import { history } from './history.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'
import { web } from './web.ts'
import { useWeb, base, cookieParts } from './web-fixture.test.ts'
import { browser, browserTest, useChrome } from './web-chrome-fixture.test.ts'

useWeb()
useChrome()

browserTest(
	'without scroll anchoring, deep history scrolls end to end and the row in view never jumps',
	async () => {
		let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
		tabs.insert(id, 0)
		for (let t = 0; t < 150; t++) {
			history.append(id, { type: 'user', blocks: [{ type: 'text', text: `prompt ${t}` }] })
			history.append(id, { type: 'assistant', block: { type: 'text', text: `reply ${t}\n\n`.repeat(1 + (t % 7)) } })
			history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
		}
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Emulation.setDeviceMetricsOverride', {
				width: 390,
				height: 844,
				deviceScaleFactor: 1,
				mobile: true,
			})
			await b.call('Page.addScriptToEvaluateOnNewDocument', {
				source: `{ let s = CSS.supports.bind(CSS); CSS.supports = (...a) => a[0] === 'overflow-anchor' ? false : s(...a); addEventListener('DOMContentLoaded', () => { let st = document.createElement('style'); st.textContent = '* { overflow-anchor: none !important }'; document.head.append(st) }) }`,
			})
			await b.call('Network.setCookie', { ...(await cookieParts()), url: base() })
			await b.call('Page.navigate', { url: `${base()}/${id}` })
			await b.waitFor(`document.querySelector('main')?.innerText.includes('reply 149')`)
			let walk = (dir: number) =>
				b.evaluate(`(async () => {
				let main = document.querySelector('.Transcript'), frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
				let seen = () => { let top = main.getBoundingClientRect().top; return [...main.querySelectorAll('.rows > [data-scroll-key]')].find(r => r.getBoundingClientRect().bottom > top) }
				let jumps = [], steps = 0, still = 0
				while (steps < 1000 && still < 3) {
					let row = seen(), y = row.getBoundingClientRect().top, before = main.scrollTop
					main.dispatchEvent(new Event('touchmove'))
					main.scrollTop += ${dir} * 900
					let moved = main.scrollTop - before
					main.dispatchEvent(new Event('touchend'))
					await new Promise(r => setTimeout(r, 250)); await frame()
					steps++
					if (!row.isConnected) { jumps.push({ steps, gone: row.dataset.scrollKey }); continue }
					let off = row.getBoundingClientRect().top - (y - moved)
					if (Math.abs(off) > 2) jumps.push({ steps, off: Math.round(off), key: row.dataset.scrollKey })
					still = moved ? 0 : still + 1
				}
				return { steps, jumps: jumps.slice(0, 10), count: jumps.length, text: main.innerText.slice(0, 40), end: main.innerText.slice(-40) }
			})()`)
			let up = await walk(-1)
			expect(up.count).toBe(0)
			expect(up.text).toContain('prompt 0')
			let down = await walk(1)
			expect(down.count).toBe(0)
			expect(down.end).toContain('reply 149')
		} finally {
			await b.close()
		}
	},
	240000,
)
