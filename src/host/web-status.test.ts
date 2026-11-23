// Browser tests of the status area: compact status, manual reload
// notice and logout.

import { expect } from 'bun:test'
import type { StreamEvent } from '../common/blocks.ts'
import { host } from './host.ts'
import { tabs } from './tabs.ts'
import { sessions } from './sessions.ts'
import { stats } from './stats.ts'
import { usage } from './usage.ts'
import { status } from './status.ts'
import { turns } from './turns.ts'
import { server } from './server.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'
import { webPage } from './web-page.ts'
import { useWeb, base, cookieParts, providerHome } from './web-fixture.test.ts'
import { browser, browserTest, useChrome } from './web-chrome-fixture.test.ts'

useWeb()
useChrome()

browserTest(
	'the chip row reads in full on two lines on phones, one line wider, and opens live session details without losing the draft',
	async () => {
		providerHome()
		let b = await browser()
		let statsOf = stats.of,
			usageSnapshot = usage.snapshot
		let accounts = { test: { '5h': { used: 17 } } }
		try {
			usage.snapshot = () => accounts
			await server.serve()
			web.start()
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
			await b.call('Page.navigate', { url: `${base()}/?auth=${webAuth.issue()}` })
			await b.waitFor("!!document.querySelector('.StatusRow .id')?.textContent")
			let id = await b.evaluate('location.pathname.slice(1)')
			let meta = {
				id,
				cwd: '/tmp/very-long-parent-directory/project',
				model: 'fake/a-very-long-model-name',
				name: 'A long conversation name that must not wrap on a narrow phone',
				createdAt: new Date().toISOString(),
			}
			Object.assign(sessions.open(id), meta)
			for (let client of host.state.clients) client.deliver({ type: 'subscription-usage', accounts })
			stats.of = () => ({
				context: 85000,
				window: 100000,
				files: 4,
				effort: 'medium',
				plan: { account: 'a1', accounts: 1, key: 'test' },
			})
			host.broadcast(meta.id, { type: 'meta', sessionId: meta.id, meta, stats: stats.of(meta.id) })
			status.transition(meta.id, { type: 'submit' })
			await b.waitFor(
				"document.querySelector('.StatusRow .context.heat-85')?.textContent === '85%' && document.querySelector('.activity')?.textContent.includes('processing')",
			)
			await b.evaluate(
				"let draft = document.querySelector('textarea'); draft.value = 'draft survives details'; draft.dispatchEvent(new Event('input', { bubbles: true }))",
			)
			for (let width of [320, 390, 1024, 1600]) {
				await b.call('Emulation.setDeviceMetricsOverride', { width, height: 760, deviceScaleFactor: 1, mobile: true })
				await b.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
				let row = await b.evaluate(`(() => {
				let q = s => document.querySelector(s), shown = s => q(s).checkVisibility();
				// Each chip takes a touch from 4px above the row to its foot.
				let reach = [...document.querySelectorAll('.StatusRow > button')].filter(e => e.checkVisibility()).every(e => {
					let r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
					return [y - 23, y + 18].every(y => document.elementFromPoint(x, y)?.closest('button') === e);
				});
				return { height: q('.StatusRow').getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth || q('.StatusRow').scrollWidth > q('.StatusRow').clientWidth, reach, cwd: q('.StatusRow .cwd').getAttribute('aria-label'), id: shown('.StatusRow .id') ? q('.StatusRow .id').textContent : '', windows: shown('.windows'), gauge: shown('.gauge'), quota: q('.gauge').getAttribute('aria-label'), bars: q('.budget .stack')?.children.length, link: !!q('.StatusRow > a'), duplicated: !!q('.Composer .status') };
			})()`)
				expect(row.height).toBe(width <= 640 ? 62 : 40)
				expect(row.overflow).toBe(false)
				expect(row.reach).toBe(true)
				expect(row.cwd).toBe(`Directory ${meta.cwd}`)
				// Only each window's own gauge depends on room.
				expect(row.id).toBe(id)
				expect(row.windows).toBe(width > 600)
				expect(row.gauge).toBe(width < 600)
				expect(row.quota).toBe('Quota: 5h 17% used')
				expect(row.bars).toBe(3)
				expect(row.link).toBe(false)
				expect(row.duplicated).toBe(false)
			}
			sessions.update(meta.id, { slots: 0 })
			await b.waitFor("document.querySelector('.budget').textContent === '0'")
			status.transition(meta.id, { type: 'end' })
			await b.waitFor("document.querySelector('.activity')?.textContent.includes('idle')")
			// A master update alone must repaint quota on this idle view. No
			// replacement Stats, transcript, status nodes or draft are needed.
			await b.evaluate(
				"window.quotaNodes = [document.querySelector('.gauge'), document.querySelector('.window'), document.querySelector('.StatusRow')]",
			)
			accounts.test['5h'].used = 52
			for (let client of host.state.clients) client.deliver({ type: 'subscription-usage', accounts })
			await b.waitFor(
				"document.querySelector('.window').textContent.includes('52%') && document.querySelector('.gauge').getAttribute('aria-label') === 'Quota: 5h 52% used'",
			)
			expect(
				await b.evaluate(
					"window.quotaNodes.every((n, i) => n === [document.querySelector('.gauge'), document.querySelector('.window'), document.querySelector('.StatusRow')][i])",
				),
			).toBe(true)
			expect(await b.evaluate("document.querySelector('textarea').value")).toBe('draft survives details')
			// An unrelated account must not touch this status row.
			await b.evaluate(
				"window.quotaMutations = 0; window.quotaObserver = new MutationObserver(ms => window.quotaMutations += ms.length); window.quotaObserver.observe(document.querySelector('.StatusRow'), { subtree: true, childList: true, characterData: true, attributes: true })",
			)
			for (let client of host.state.clients)
				client.deliver({ type: 'subscription-usage', accounts: { other: { '5h': { used: 99 } } } })
			await b.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
			expect(await b.evaluate('window.quotaMutations')).toBe(0)
			await b.evaluate('window.quotaObserver.disconnect()')
			let enter = async () => {
				await b.call('Input.dispatchKeyEvent', {
					type: 'keyDown',
					key: 'Enter',
					code: 'Enter',
					windowsVirtualKeyCode: 13,
					text: '\r',
				})
				await b.call('Input.dispatchKeyEvent', {
					type: 'keyUp',
					key: 'Enter',
					code: 'Enter',
					windowsVirtualKeyCode: 13,
				})
			}
			await b.evaluate("document.querySelector('.StatusRow .more').focus()")
			await enter()
			// The toggle event moves focus into the menu just after it opens.
			await b.waitFor("document.querySelector('#panel-menu').contains(document.activeElement)")
			await b.evaluate(
				"[...document.querySelectorAll('#panel-menu .row')].find(r => r.textContent.includes('Session details')).focus()",
			)
			await enter()
			await b.waitFor("document.querySelector('.StatusDetails').open")
			let text = await b.evaluate("document.querySelector('.StatusDetails').textContent")
			expect(text).toContain(meta.name)
			expect(text).toContain(meta.cwd)
			expect(text).toContain('medium')
			expect(text).toContain('5h 52%')
			expect(
				await b.evaluate("[...document.querySelectorAll('.StatusDetails a')].map(a => a.getAttribute('href'))"),
			).toEqual([`/${id}/changes`, `/context/${id}`])
			status.transition(meta.id, { type: 'submit' })
			status.transition(meta.id, { type: 'pause' })
			await b.waitFor("document.querySelector('.StatusDetails p').textContent.startsWith('paused')")
			await b.call('Input.dispatchKeyEvent', {
				type: 'keyDown',
				key: 'Escape',
				code: 'Escape',
				windowsVirtualKeyCode: 27,
			})
			await b.call('Input.dispatchKeyEvent', {
				type: 'keyUp',
				key: 'Escape',
				code: 'Escape',
				windowsVirtualKeyCode: 27,
			})
			await b.waitFor("!document.querySelector('.StatusDetails').open")
			expect(await b.evaluate("document.activeElement === document.querySelector('.StatusRow .more')")).toBe(true)
			expect(await b.evaluate("document.querySelector('textarea').value")).toBe('draft survives details')
		} finally {
			stats.of = statsOf
			usage.snapshot = usageSnapshot
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
			await b.close()
		}
	},
	20_000,
)

browserTest(
	'manual reload notice preserves the draft and command actions stay distinct from steering',
	async () => {
		providerHome()
		let id = tabs.create('/tmp')
		let finish = () => {}
		turns.stream = () =>
			(async function* (): AsyncGenerator<StreamEvent> {
				yield { type: 'text', text: 'Still working' }
				await new Promise<void>((resolve) => {
					finish = resolve
				})
				yield { type: 'done', reason: 'end' }
			})()
		let b = await browser()
		let build = webPage.build
		try {
			await server.serve()
			web.start()
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
			await b.call('Emulation.setDeviceMetricsOverride', {
				width: 390,
				height: 760,
				deviceScaleFactor: 1,
				mobile: true,
			})
			await b.call('Network.setCookie', { ...(await cookieParts()), url: base() })
			await b.call('Page.navigate', { url: `${base()}/${id}` })
			await b.waitFor("document.querySelector('.activity')?.textContent.includes('idle')")
			let input = (text: string) =>
				b.evaluate(
					`(() => { let t = document.querySelector('textarea'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`,
				)
			let actions = () =>
				b.evaluate(
					"[...document.querySelectorAll('.Composer .actions button')].map(b => b.getAttribute('aria-label') ?? b.textContent)",
				)
			// Idle with an empty draft: Play is enabled, even before an answer (task yhn).
			expect(
				await b.evaluate(
					"[...document.querySelectorAll('.Composer .actions button')].map(b => [b.getAttribute('aria-label'), b.disabled])",
				),
			).toEqual([
				['Nudge', false],
				['Send', true],
			])
			await input('start')
			await b.evaluate("document.querySelector('.Composer .actions .go').click()")
			await b.waitFor("document.querySelector('main').textContent.includes('Still working')")
			await input('later')
			expect(await actions()).toEqual(['Pause (Esc)', 'Queue', 'Steer'])
			// Named buttons (task 02s) keep 44px targets and fit the 390px row.
			let fit = await b.evaluate(
				"(() => { let rs = [...document.querySelectorAll('.Composer .actions button')].map(b => b.getBoundingClientRect()); return { small: Math.min(...rs.map(r => Math.min(r.width, r.height))), right: Math.max(...rs.map(r => r.right)), width: document.documentElement.clientWidth, names: [...document.querySelectorAll('.Composer .actions small')].map(s => s.textContent) } })()",
			)
			expect(fit.names).toEqual(['Pause', 'Queue', 'Steer'])
			expect(fit.small).toBeGreaterThanOrEqual(44)
			expect(fit.right).toBeLessThanOrEqual(fit.width)
			await input('/model')
			expect(await actions()).toEqual(['Pause (Esc)', 'Run'])
			expect(await b.evaluate("document.querySelector('.Composer .help').textContent.includes('alt+enter')")).toBe(
				false,
			)
			await input('draft stays put')
			await b.evaluate(
				"document.querySelector('textarea').focus(); window.__beforeUpdate = document.querySelector('.Chat'); window.__oldText = document.querySelector('textarea'); window.__transcriptRect = document.querySelector('.Transcript').getBoundingClientRect().toJSON()",
			)
			let page = await webPage.state.page!
			webPage.build = async () => ({
				html: page.html.replace(`data-version="${page.version}"`, 'data-version="updated"'),
				version: 'updated',
			})
			await webPage.refresh()
			await b.waitFor("document.querySelector('.source-update button')?.textContent === 'reload'")
			let geometry = await b.evaluate(`(() => {
			let button = document.querySelector('.source-update button'), r = button.getBoundingClientRect(), tabs = document.querySelector('.Tabs').getBoundingClientRect();
			let transcript = document.querySelector('.Transcript').getBoundingClientRect();
			return { unchanged: transcript.top === window.__transcriptRect.top && transcript.height === window.__transcriptRect.height, overlay: r.top >= transcript.top && r.bottom <= transcript.bottom, background: getComputedStyle(button).backgroundColor, anchor: document.querySelector('.source-update').getBoundingClientRect().height, font: getComputedStyle(button).fontSize, border: getComputedStyle(button).borderTopWidth, height: r.height, width: r.width, clear: r.top >= tabs.bottom, focused: document.activeElement === window.__oldText, same: document.querySelector('.Chat') === window.__beforeUpdate, draft: document.querySelector('textarea').value };
		})()`)
			expect(geometry).toMatchObject({
				unchanged: true,
				overlay: true,
				anchor: 0,
				font: '16px',
				border: '0px',
				clear: true,
				focused: true,
				same: true,
				draft: 'draft stays put',
			})
			expect(geometry.background).toContain('0.75')
			expect(geometry.height).toBeGreaterThanOrEqual(24)
			expect(geometry.width).toBeGreaterThanOrEqual(44)
			// A second rebuild keeps one persistent notice and the same page.
			await webPage.refresh()
			expect(await b.evaluate("document.querySelectorAll('.source-update').length")).toBe(1)
			finish()
			await b.waitFor("document.querySelector('.activity').textContent.includes('idle')")
			await input('/help')
			expect(await actions()).toEqual(['Nudge', 'Run'])
			await input('draft stays put')
			await b.evaluate("document.querySelector('.source-update button').click()")
			await b.waitFor("!window.__beforeUpdate && document.querySelector('textarea')?.value === 'draft stays put'")
			expect(await b.evaluate("document.querySelector('.source-update') === null")).toBe(true)
		} finally {
			finish()
			webPage.build = build
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
			await b.close()
		}
	},
	20000,
)

browserTest(
	'browser status logout fits phone and desktop and returns to the login gate',
	async () => {
		providerHome()
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Page.navigate', { url: `${base()}/?auth=${webAuth.issue()}` })
			await b.waitFor(
				`!!document.querySelector('.StatusRow .id')?.textContent && !!document.querySelector('textarea:not(:disabled)')`,
			)
			let details = `document.querySelector('.StatusRow .more').click(); [...document.querySelectorAll('#panel-menu .row')].find(r => r.textContent.includes('Session details')).click()`
			for (let width of [390, 1280]) {
				await b.call('Emulation.setDeviceMetricsOverride', {
					width,
					height: 800,
					deviceScaleFactor: 1,
					mobile: width === 390,
				})
				await b.evaluate(details)
				await b.waitFor(`document.querySelector('.StatusDetails').open`)
				let r = await b.evaluate(
					`(() => { let b = document.querySelector('.StatusDetails form button'), r = b.getBoundingClientRect(); return { text: b.textContent, height: r.height, left: r.left, right: r.right, viewport: innerWidth }; })()`,
				)
				expect(r.text).toBe('Log out this browser')
				expect(r.height).toBeGreaterThanOrEqual(44)
				expect(r.left).toBeGreaterThanOrEqual(0)
				expect(r.right).toBeLessThanOrEqual(r.viewport)
				await b.evaluate(`document.querySelector('.StatusDetails').close()`)
			}
			await b.evaluate(`${details}; document.querySelector('.StatusDetails form button').click()`)
			await b.waitFor(`!!document.querySelector('.Login')`)
			expect(webAuth.list()).toHaveLength(0)
		} finally {
			await b.close()
		}
	},
	15000,
)
