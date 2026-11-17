// Checks wake recovery between reconnection and the visible snapshot.
import { expect } from 'bun:test'
import type { StreamEvent } from '../common/blocks.ts'
import { host } from './host.ts'
import { tabs } from './tabs.ts'
import { turns } from './turns.ts'
import { server } from './server.ts'
import { web } from './web.ts'
import { history } from './history.ts'
import { pages } from './pages.ts'
import { webAuth } from './web-auth.ts'
import { useWeb, base, providerHome, until } from './web-fixture.test.ts'
import { browser, browserTest, useChrome } from './web-chrome-fixture.test.ts'

useWeb()
useChrome()

browserTest(
	'wake replaces a stale open socket and holds motion until the visible snapshot',
	async () => {
		providerHome()
		let id = tabs.create('/tmp')
		let finish = () => {}
		turns.stream = () =>
			(async function* (): AsyncGenerator<StreamEvent> {
				yield { type: 'text', text: Array.from({ length: 80 }, (_, n) => `Reading line ${n}`).join('\n\n') }
				await new Promise<void>((resolve) => {
					finish = resolve
				})
				yield { type: 'done', reason: 'end' }
			})()
		let b = await browser()
		let follow = host.follow
		let held: Parameters<typeof host.follow>[] = []
		let holding = false
		await b.call('Page.enable', {})
		let script = await b.call('Page.addScriptToEvaluateOnNewDocument', {
			source: `
		window.wakeSockets = [];
		window.WebSocket = class extends WebSocket {
			constructor(...args) { super(...args); window.wakeSockets.push(this) }
		};
		window.wakeClock = 0;
		const clock = Date.now;
		Date.now = () => clock() + window.wakeClock;
	`,
		})
		try {
			await server.serve()
			web.start()
			await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
			await b.waitFor("document.querySelector('.activity')?.textContent.includes('idle')")
			await b.evaluate(`(() => {
			let t = document.querySelector('textarea'); t.value = 'start';
			t.dispatchEvent(new Event('input', { bubbles: true }));
		})()`)
			await b.evaluate("document.querySelector('.Composer .actions .go').click()")
			await b.waitFor(
				"document.querySelector('.Card .cursor') && document.querySelector('.activity')?.textContent.includes('writing')",
			)
			for (let width of [390, 1280]) {
				await b.call('Emulation.setDeviceMetricsOverride', { width, height: 760, deviceScaleFactor: 1, mobile: false })
				await b.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
				await b.evaluate(`(() => {
				let t = document.querySelector('textarea'); t.value = 'draft survives wake';
				t.dispatchEvent(new Event('input', { bubbles: true }));
				let main = document.querySelector('.Transcript'); main.scrollTop = -300;
			})()`)
				await b.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
				await b.evaluate(`(() => {
				let socket = window.wakeSockets.at(-1); socket.onmessage = () => {};
				window.wakeNodes = [document.querySelector('textarea'), document.querySelector('.Card.assistant'), document.querySelector('.Transcript')];
				window.wakeTop = window.wakeNodes[2].scrollTop;
			})()`)
				host.follow = (...args) => {
					if (holding) held.push(args)
					else follow(...args)
				}
				holding = true
				await b.evaluate(
					width === 390 ? "window.wakeClock += 10000; dispatchEvent(new Event('focus'))" : 'window.wakeClock += 10000',
				)
				await b.waitFor("document.querySelector('.activity')?.textContent.includes('Updating...')")
				expect(
					await b.evaluate(`(() => {
				let q = s => document.querySelector(s);
				return { stale: q('.Chat').classList.contains('stale'),
					cursor: getComputedStyle(q('.Card .cursor')).animationPlayState,
					marker: getComputedStyle(q('.Tabs .marker.blink')).animationPlayState,
					draft: q('textarea').value, same: window.wakeNodes.every((n, i) => n === [q('textarea'), q('.Card.assistant'), q('.Transcript')][i]),
					shift: q('.Transcript').scrollTop - window.wakeTop };
			})()`),
				).toEqual({
					stale: true,
					cursor: 'paused',
					marker: 'paused',
					draft: 'draft survives wake',
					same: true,
					shift: 0,
				})
				holding = false
				for (let args of held.splice(0)) follow(...args)
				await b.waitFor("!document.querySelector('.Chat').classList.contains('stale')")
				expect(await b.evaluate("getComputedStyle(document.querySelector('.Card .cursor')).animationPlayState")).toBe(
					'running',
				)
				expect(await b.evaluate("document.querySelector('.Transcript').scrollTop - window.wakeTop")).toBe(0)
				expect(await b.evaluate("document.querySelector('textarea').value")).toBe('draft survives wake')
			}
			await b.evaluate('window.wakeSockets.at(-1).onmessage = () => {}')
			finish()
			await until(() => !turns.state.running.has(id))
			expect(await b.evaluate("document.querySelector('.activity').textContent.includes('writing')")).toBe(true)
			await b.evaluate('window.wakeClock += 10000')
			await b.waitFor("document.querySelector('.activity')?.textContent.includes('idle')")
			expect(await b.evaluate("document.querySelector('.Card .cursor')")).toBeNull()
			expect(await b.evaluate("document.querySelector('textarea').value")).toBe('draft survives wake')
		} finally {
			finish()
			host.follow = follow
			await b.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.result.identifier })
			await b.close()
		}
	},
	20_000,
)

browserTest(
	'wake retains the loaded older card and reading position until its fresh page arrives',
	async () => {
		let id = tabs.create('/tmp')
		let records = Array.from({ length: 12 }, (_, n) =>
			history.append(id, { type: 'output', text: `Older message ${n}\n${'Reading this line\n'.repeat(30)}` }),
		)
		pages.budget = 800
		let b = await browser()
		let follow = host.follow
		let held: (() => void)[] = []
		let holding = false
		try {
			await server.serve()
			web.start()
			await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}#${records[0]!.n}` })
			await b.waitFor("document.querySelector('.Card.target')?.textContent.includes('Older message 0')")
			await b.evaluate("window.wakeAnchor = document.querySelector('.Card.target')")
			await b.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
			await b.evaluate('window.wakeAnchorTop = wakeAnchor.getBoundingClientRect().top')
			holding = true
			host.follow = (client, ...args) => {
				let deliver = client.deliver
				client.deliver = (event) => {
					if (holding && event.type === 'history') held.push(() => deliver(event))
					else deliver(event)
				}
				follow(client, ...args)
			}
			await b.evaluate(`(() => {
			let clock = Date.now; Date.now = () => clock() + 10000;
			dispatchEvent(new Event('focus'));
		})()`)
			await until(() => held.length > 0)
			await b.waitFor("document.querySelector('.activity')?.textContent.includes('Updating...')")
			let position = () =>
				b.evaluate(`({
			connected: wakeAnchor.isConnected,
			shift: wakeAnchor.getBoundingClientRect().top - wakeAnchorTop,
			oldest: document.querySelector('.Transcript').innerText.includes('Older message 0')
		})`)
			expect(await position()).toEqual({ connected: true, shift: 0, oldest: true })
			holding = false
			for (let deliver of held.splice(0)) deliver()
			await b.waitFor("!document.querySelector('.Chat').classList.contains('stale')")
			await b.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
			expect(await position()).toEqual({ connected: true, shift: 0, oldest: true })
		} finally {
			host.follow = follow
			await b.close()
		}
	},
	20_000,
)
