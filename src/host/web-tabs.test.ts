// Browser tests of the tab strip: drafts while switching, tab squares,
// tab links and paging.

import { expect } from 'bun:test'
import { host } from './host.ts'
import { tabs } from './tabs.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'
import { testHome, useWeb, base, cookieParts, providerHome } from './web-fixture.test.ts'
import { browser, browserTest, useChrome } from './web-chrome-fixture.test.ts'

useWeb()
useChrome()

browserTest('Unicode drafts keep the composer and tab navigation responsive', async () => {
	let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
	let other = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
	tabs.insert(id, 0)
	tabs.insert(other, 1)
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
		await b.waitFor(`!!document.querySelector('.Chat')`)
		await b.waitFor(
			`!!document.querySelector('.StatusRow .id')?.textContent && !!document.querySelector('textarea:not(:disabled)')`,
		)
		for (let width of [390, 1440]) {
			await b.call('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false })
			for (let text of ['é', '—', '漢字', '👨‍👩‍👧', 'e\u0301']) {
				await b.evaluate(
					`(() => { let t = document.querySelector('textarea'); t.value = ''; t.dispatchEvent(new InputEvent('input', { bubbles: true })); t.focus() })()`,
				)
				await b.waitFor(`document.querySelector('.actions button[aria-label="Send"]').disabled`)
				await b.call('Input.insertText', { text })
				await b.waitFor(`!document.querySelector('.actions button[aria-label="Send"]').disabled`)
				expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe(text)
			}
			await b.evaluate(`document.querySelector('.Tabs [href="/${other}"]').click()`)
			await b.waitFor(
				`document.querySelector('.Tabs [href="/${other}"]').hasAttribute('aria-current') && document.querySelector('textarea').value === ''`,
			)
			await b.evaluate(`document.querySelector('.Tabs [href="/${id}"]').click()`)
			await b.waitFor(`document.querySelector('textarea').value === 'e\\u0301'`)
		}
	} finally {
		await b.close()
	}
})

browserTest('tab status dots sit inside each tab and pulse in terminal colors', async () => {
	let id = tabs.create('/tmp')
	tabs.create('/tmp')
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Network.setCookie', { ...(await cookieParts()), url: base() })
		await b.call('Page.navigate', { url: `${base()}/${id}` })
		await b.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
		await b.waitFor(`!!document.querySelector('.Tabs .strip .tab .n')`)
		let list = tabs
			.list()
			.map((t) => ({ ...t, state: { type: 'running' as const, phase: 'streaming' as const }, jobs: 1 }))
		for (let c of host.state.clients) c.deliver({ type: 'tabs', tabs: list })
		let marker = `document.querySelector('.Tabs .strip .tab:not([aria-current]) .marker.working')`
		await b.waitFor(`!!${marker}?.classList.contains('with-jobs') && !!${marker}.getAnimations().length`)
		let result = JSON.parse(
			await b.evaluate(`JSON.stringify((() => {
			let m = ${marker}, tab = m.closest('.tab');
			let mr = m.getBoundingClientRect(), tr = tab.getBoundingClientRect();
			let a = m.getAnimations()[0]; a.pause(); a.effect.updateTiming({ delay: 0 });
			let ctx = document.createElement('canvas').getContext('2d');
			let rgb = color => { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
			let values = [0, 500, 1000, 1500].map(t => { a.currentTime = t; return [rgb(getComputedStyle(m).color), getComputedStyle(m).opacity]; });
			let s = getComputedStyle(m);
			return { inside: mr.left >= tr.left && mr.right <= tr.right && mr.top >= tr.top && mr.bottom <= tr.bottom, round: s.borderRadius, values, lit: rgb(s.getPropertyValue('--mark-lit').trim()), dark: rgb(s.getPropertyValue('--mark-dark').trim()), alt: rgb(s.getPropertyValue('--jobs-fg').trim()) };
		})())`),
		)
		expect(result.inside).toBe(true)
		expect(result.round).toBe('50%')
		expect(result.values).toEqual([result.lit, result.dark, result.alt, result.dark].map((c) => [c, '1']))
	} finally {
		await b.call('Emulation.setEmulatedMedia', { features: [] })
		await b.close()
	}
})

browserTest(
	'in a browser tabs are links; new, Back and close move the address; the strip stays one short row',
	async () => {
		let origCwd = host.cwd
		host.cwd = () => '/tmp'
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Network.setCookie', { ...(await cookieParts()), url: base() })
			await b.call('Emulation.setDeviceMetricsOverride', {
				width: 1200,
				height: 800,
				deviceScaleFactor: 1,
				mobile: false,
			})
			await b.call('Page.navigate', { url: `${base()}/` })
			// Landing on the first (new) tab rewrites the address.
			await b.waitFor(
				`document.querySelectorAll('.Tabs .strip a.tab').length === 1 && /\\/\\d+-[a-z]{3}$/.test(location.pathname)`,
			)
			let first = await b.evaluate(`location.pathname`)
			expect(await b.evaluate(`document.querySelector('.Tabs .strip a.tab').getAttribute('href')`)).toBe(first)
			await b.evaluate(`document.querySelector('.Tabs .strip .new').click()`)
			await b.waitFor(
				`document.querySelectorAll('.Tabs .strip a.tab').length === 2 && location.pathname !== '${first}'`,
			)
			let second = await b.evaluate(`location.pathname`)
			expect(await b.evaluate(`document.querySelector('.Tabs .strip [aria-current]').getAttribute('href')`)).toBe(
				second,
			)
			// The strip never scrolls sideways.
			expect(
				await b.evaluate(
					`(() => { let s = document.querySelector('.Tabs .strip'); return s.scrollWidth <= s.clientWidth })()`,
				),
			).toBe(true)
			// Back shows the first tab again; a click on a tab link pushes.
			await b.evaluate(`history.back()`)
			await b.waitFor(
				`location.pathname === '${first}' && document.querySelector('.Tabs .strip [aria-current]')?.getAttribute('href') === '${first}'`,
			)
			await b.evaluate(`document.querySelector('.Tabs .strip a[href="${second}"]').click()`)
			await b.waitFor(`location.pathname === '${second}'`)
			// Closing the shown tab lands on its neighbor, replacing the entry.
			let entries = await b.evaluate(`history.length`)
			// A real click: focus moves, running focus handlers as the sheet opens.
			let count = JSON.parse(
				await b.evaluate(`JSON.stringify(document.querySelector('.Tabs .count').getBoundingClientRect())`),
			)
			for (let type of ['mousePressed', 'mouseReleased'])
				await b.call('Input.dispatchMouseEvent', {
					type,
					x: count.x + count.width / 2,
					y: count.y + count.height / 2,
					button: 'left',
					clickCount: 1,
				})
			await b.waitFor(`document.querySelector('.Tabs .sheet').open`)
			expect(
				await b.evaluate(
					`document.activeElement === document.querySelector('.Tabs .sheet ul') && getComputedStyle(document.activeElement).outlineStyle === 'none'`,
				),
			).toBe(true)
			expect(await b.evaluate(`document.querySelector('.Tabs .sheet [aria-current]').getAttribute('href')`)).toBe(
				second,
			)
			await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
			await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
			expect(
				await b.evaluate(
					`document.activeElement === document.querySelector('.Tabs .sheet a') && document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle !== 'none'`,
				),
			).toBe(true)
			await b.evaluate(`document.querySelector('.Tabs .sheet li:has([aria-current]) .close').click()`)
			await b.waitFor(
				`document.querySelectorAll('.Tabs .strip a.tab').length === 1 && location.pathname === '${first}'`,
			)
			expect(await b.evaluate(`history.length`)).toBe(entries)
			// A phone: two-tier header (title + count over scrollable rail).
			await b.call('Emulation.setDeviceMetricsOverride', {
				width: 390,
				height: 800,
				deviceScaleFactor: 1,
				mobile: true,
			})
			expect(
				await b.evaluate(
					`getComputedStyle(document.querySelector('.Tabs .head')).display !== 'none' && document.querySelector('.Tabs').getBoundingClientRect().height <= 90`,
				),
			).toBe(true)
			await b.evaluate(`document.querySelector('.Tabs .sheet').open || document.querySelector('.Tabs .count').click()`)
			await b.waitFor(
				`document.querySelector('.Tabs .sheet').open && document.querySelectorAll('.Tabs .sheet a').length === 1`,
			)
			expect(await b.evaluate(`document.querySelector('.Tabs .sheet ul').getBoundingClientRect().height >= 44`)).toBe(
				true,
			)
			await b.evaluate(
				`[...document.querySelectorAll('.Tabs .sheet button')].find(b => b.textContent.trim() === 'Find').click()`,
			)
			await b.waitFor(`document.querySelector('.Picker[open]') && !document.querySelector('.Tabs .sheet').open`)
			await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' })
			await b.waitFor(`!document.querySelector('.Picker[open]')`)
			await b.evaluate(`document.querySelector('.Tabs .count').click()`)
			await b.waitFor(`document.querySelector('.Tabs .sheet').open`)
			await b.evaluate(`document.querySelector('.Tabs .sheet .new').click()`)
			await b.waitFor(`!document.querySelector('.Tabs .sheet').open && location.pathname !== '${first}'`)
			expect(await b.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
			// The list's Notifications sheet opens and closes.
			await b.evaluate(`document.querySelector('.Tabs .count').click()`)
			await b.waitFor(`document.querySelector('.Tabs .sheet').open`)
			await b.evaluate(
				`[...document.querySelectorAll('.Tabs .sheet button')].find(b => b.textContent === 'Notifications').click()`,
			)
			await b.waitFor(`document.querySelector('.Notifications').open && !document.querySelector('.Tabs .sheet').open`)
			await b.evaluate(
				`[...document.querySelectorAll('.Notifications button')].find(b => b.textContent === 'Close').click()`,
			)
			await b.waitFor(`!document.querySelector('.Notifications').open`)
		} finally {
			host.cwd = origCwd
			await b.close()
		}
	},
	20000,
)

browserTest(
	'the web tab strip scrolls natively without selecting, its count dots a waiting tab off screen, and selection centers',
	async () => {
		providerHome()
		let ids = Array.from({ length: 21 }, () => sessions.create({ cwd: testHome() }).id)
		tabs.file().open = ids
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Emulation.setDeviceMetricsOverride', {
				width: 390,
				height: 800,
				deviceScaleFactor: 1,
				mobile: true,
			})
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
			await b.call('Page.navigate', { url: `${base()}/${ids[0]}?auth=${webAuth.issue()}` })
			await b.waitFor(`document.querySelectorAll('.track .tab').length === 21`)
			let geometry = `(() => {
			let track = document.querySelector('.track'), r = track.getBoundingClientRect(), links = [...track.querySelectorAll('.tab')];
			let visible = links.filter(a => { let t = a.getBoundingClientRect(); return t.left >= r.left - 1 && t.right <= r.right + 1 });
			let key = track.querySelector('[aria-current]').getBoundingClientRect(), count = document.querySelector('.Tabs .count').getBoundingClientRect();
			return { first: links.indexOf(visible[0]), last: links.indexOf(visible.at(-1)), path: location.pathname, scroll: track.scrollLeft, height: links[1].getBoundingClientRect().height, width: Math.min(...links.map(a => a.getBoundingClientRect().width)), count: Math.min(count.width, count.height), offCenter: Math.abs(key.left + key.width / 2 - r.left - r.width / 2), dot: document.querySelector('.Tabs .count .dot')?.dataset.mark ?? '', snap: getComputedStyle(track).scrollSnapType };
		})()`
			let first = await b.evaluate(geometry)
			expect(first.first).toBe(0)
			expect(first.last).toBeGreaterThan(0)
			expect(first.height).toBeGreaterThanOrEqual(44)
			expect(first.width).toBeGreaterThanOrEqual(44)
			expect(first.count).toBeGreaterThanOrEqual(44)
			expect(first.dot).toBe('')
			expect(first.snap).toBe('x') // CSSOM omits the default proximity value.
			// Native touch scrolling moves only the strip, not the active session.
			let swipe = await b.evaluate(
				"(() => { let r = document.querySelector('.track').getBoundingClientRect(); return { x: r.right - 20, y: r.y + r.height / 2 } })()",
			)
			await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [swipe] })
			for (let i = 1; i <= 8; i++) {
				await b.call('Input.dispatchTouchEvent', {
					type: 'touchMove',
					touchPoints: [{ x: swipe.x - i * 15, y: swipe.y }],
				})
				await Bun.sleep(16)
			}
			await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
			await b.evaluate(
				"new Promise(resolve => { let track = document.querySelector('.track'), last = track.scrollLeft, still = 0; let check = () => { let now = track.scrollLeft; still = now === last ? still + 1 : 0; last = now; if (still >= 10) resolve(); else requestAnimationFrame(check); }; requestAnimationFrame(check) })",
			)
			await b.waitFor(`(${geometry}).scroll > 0`)
			let swiped = await b.evaluate(geometry)
			expect(swiped.path).toBe(`/${ids[0]}`)
			// A failed tab off screen dots the count, but never recenters.
			status.transition(ids[20]!, { type: 'submit' })
			status.transition(ids[20]!, { type: 'end', error: 'test failure' })
			await b.waitFor(`(${geometry}).dot === 'failed'`)
			expect((await b.evaluate(geometry)).scroll).toBeCloseTo(swiped.scroll, 0)
			// Select a hidden session using its native link; selection centers it.
			await b.evaluate(
				"new Promise(resolve => { document.querySelector('.track').addEventListener('scrollend', () => requestAnimationFrame(resolve), { once: true }); document.querySelectorAll('.track .tab')[10].click() })",
			)
			await b.waitFor(`location.pathname === '/${ids[10]}' && (${geometry}).offCenter <= 44`)
			// Opening the list sheet shows a tall vertical scrollable list of tabs.
			await b.evaluate(`document.querySelector('.Tabs .count').click()`)
			await b.waitFor(`document.querySelector('.Tabs .sheet').open`)
			let sheetList = await b.evaluate(
				`(() => { let ul = document.querySelector('.Tabs .sheet ul'); return { height: ul.getBoundingClientRect().height, scrollHeight: ul.scrollHeight }; })()`,
			)
			expect(sheetList.height).toBeGreaterThan(250)
			expect(sheetList.scrollHeight).toBeGreaterThan(sheetList.height)
			await b.evaluate(`document.querySelector('.Tabs .sheet .sheet-close').click()`)
			await b.waitFor(`!document.querySelector('.Tabs .sheet').open`)
			// At the scroll end the last tab counts as on screen, so the dot goes.
			await b.evaluate(`document.querySelector('.track').scrollTo({ left: 1e6, behavior: 'instant' })`)
			await b.waitFor(`(${geometry}).last === 20 && (${geometry}).dot === ''`)
			expect((await b.evaluate(geometry)).path).toBe(`/${ids[10]}`)
		} finally {
			await b.close()
		}
	},
	20000,
)
