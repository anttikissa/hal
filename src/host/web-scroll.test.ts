// Browser tests of the reading position and native selection while Hal
// streams.

import { expect } from 'bun:test'
import type { StreamEvent } from '../common/blocks.ts'
import { tabs } from './tabs.ts'
import { turns } from './turns.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { web } from './web.ts'
import { useWeb, base, cookie, providerHome } from './web-fixture.test.ts'
import { browser, browserTest, useChrome } from './web-chrome-fixture.test.ts'

useWeb()
useChrome()

browserTest(
	'in a browser a command stays below the block already streaming: same card, no fade again',
	async () => {
		providerHome()
		let id = tabs.create('/tmp')
		let release = () => {}
		let gate = new Promise<void>((r) => (release = r))
		turns.stream = () =>
			(async function* (): AsyncGenerator<StreamEvent> {
				yield { type: 'text', text: 'streaming now' }
				await gate
				yield { type: 'done', reason: 'end' }
			})()
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
			await b.call('Page.navigate', { url: `${base()}/${id}` })
			// Commands naming /help wait in the page until let go, so the
			// pending card is shown (and done fading in) before it lands.
			await b.evaluate(`(() => {
			let send = WebSocket.prototype.send, held = []
			window.letGo = () => held.splice(0).forEach((f) => f())
			WebSocket.prototype.send = function (data) { String(data).includes('/help') ? held.push(() => send.call(this, data)) : send.call(this, data) }
		})()`)
			let enter = (text: string) =>
				b.evaluate(
					`(() => { let t = document.querySelector('textarea'); t.value = '${text}'; t.dispatchEvent(new InputEvent('input', { bubbles: true })); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`,
				)
			await b.waitFor(`!!document.querySelector('.entry .hint')?.textContent`)
			await enter('go')
			await b.waitFor(`document.querySelector('main')?.innerText.includes('streaming now')`)
			await enter('/help')
			await b.waitFor(
				`(() => { let c = document.querySelector('.Card.pending'); return c && c.textContent.endsWith('/help') && !c.getAnimations().some((a) => !(a instanceof CSSTransition)) })()`,
			)
			let moved = await b.evaluate(`(async () => {
			let card = document.querySelector('.Card.pending'), reply = document.querySelector('.Card.assistant')
			let before = !!(reply.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)
			window.letGo()
			for (let i = 0; i < 250 && (card.classList.contains('pending') || !card.querySelector('.contents')); i++) await new Promise((r) => setTimeout(r, 10))
			return {
				wasAfter: before,
				same: card.isConnected && !card.classList.contains('pending'),
				nowAfter: !!(reply.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING),
				// A color easing back from pending is not a fade.
				fading: [card, reply].some((c) => c.getAnimations().some((a) => !(a instanceof CSSTransition))),
				copies: [...document.querySelectorAll('.Card')].filter((c) => c.querySelector('.CardHeader .label')?.textContent === '/help').length,
			}
		})()`)
			expect(moved).toEqual({ wasAfter: true, same: true, nowAfter: true, fading: false, copies: 1 })
			release()
		} finally {
			release()
			await b.close()
		}
	},
	20000,
)

// Selection belongs to the browser: tests may inspect it; rendering must not.
browserTest(
	'streaming preserves native selection and Markdown text nodes without holding updates',
	async () => {
		providerHome()
		let b = await browser(),
			release = () => {}
		try {
			await server.serve()
			web.start()
			let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
			tabs.insert(id, 0)
			await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
			await b.call('Page.navigate', { url: `${base()}/${id}` })
			await b.waitFor(`!!document.querySelector('textarea') && !!document.querySelector('.StatusRow')`)
			for (let [seed, delta, selector] of [
				['alpha bravo', ' charlie', '.line span span'],
				['alpha bravo\n\nLater paragraph', ' charlie', '.line span span'],
				['**alpha bravo', ' charlie**', '.b'],
				['```txt\nalpha bravo', ' charlie\n```', 'code'],
				['https://example.com/alpha', '/bravo', '.Markdown a'],
				['| Name | Value |\n|---|---|\n| alpha | bravo |\n| charlie', ' | delta |\n\nnext', 'td span'],
			]) {
				let advance = () => {},
					gate = new Promise<void>((r) => {
						advance = r
					})
				let finish = new Promise<void>((r) => {
					release = r
				})
				turns.stream = () =>
					(async function* (): AsyncGenerator<StreamEvent> {
						yield { type: 'text', text: seed! }
						await gate
						yield { type: 'text', text: delta! }
						await finish
						yield { type: 'done', reason: 'end' }
					})()
				await b.waitFor(
					`getSelection().removeAllRanges(); (() => { let t = document.querySelector('textarea'); t.value = 'selection'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return !document.querySelector('#notice').textContent })()`,
				)
				await b.waitFor(`!![...document.querySelectorAll('.Card.assistant')].at(-1)?.querySelector('.cursor')`)
				await b.evaluate(`(() => {
				let root = [...document.querySelectorAll('.Card.assistant')].at(-1)
				window.selectedElement = root.querySelector(${JSON.stringify(selector)})
				window.selectedNode = selectedElement.firstChild
				let range = document.createRange(); range.setStart(selectedNode, 1); range.setEnd(selectedNode, 4)
				getSelection().removeAllRanges(); getSelection().addRange(range)
				window.selectedText = getSelection().toString()
			})()`)
				let check = () =>
					b.evaluate(`(() => {
				let s = getSelection(), r = s.getRangeAt(0)
				return { element: selectedElement.isConnected, node: selectedElement.firstChild === selectedNode,
					start: r.startContainer === selectedNode && r.startOffset === 1,
					end: r.endContainer === selectedNode && r.endOffset === 4, text: s.toString() === selectedText }
			})()`)
				advance()
				await b.waitFor(
					`[...document.querySelectorAll('.Card.assistant')].at(-1)?.innerText.includes(${JSON.stringify(selector === 'td span' ? 'delta' : delta!.includes('charlie') ? 'charlie' : '/bravo')})`,
				)
				expect(await check()).toEqual({ element: true, node: true, start: true, end: true, text: true })
				release()
				await b.waitFor(`!!document.querySelector('.cursor-line')`)
				expect(await check()).toEqual({ element: true, node: true, start: true, end: true, text: true })
			}
		} finally {
			release()
			await b.close()
		}
	},
	20000,
)

// A reader scrolled up with everything selected (Cmd+A) while Hal
// streams 80 rows: no update may remove a shown node, move the focus,
// collapse the selection or scroll the view.
// Task 4s, pinned bottom: a card can grow with no DOM change (its open
// animation, an image); a reader at the bottom must still end there.
browserTest('a pinned reader stays at the bottom when a card grows by itself', async () => {
	providerHome()
	let b = await browser()
	try {
		await server.serve()
		web.start()
		let id = tabs.create('/tmp')
		await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
		await b.call('Emulation.setDeviceMetricsOverride', {
			width: 1200,
			height: 800,
			deviceScaleFactor: 1,
			mobile: false,
		})
		await b.call('Page.navigate', { url: `${base()}/${id}` })
		await b.waitFor(`!!document.querySelector('textarea') && !!document.querySelector('.StatusRow')`)
		turns.stream = () =>
			(async function* (): AsyncGenerator<StreamEvent> {
				for (let i = 0; i < 40; i++) yield { type: 'text', text: `Line ${i} text.\n\n` }
				yield { type: 'done', reason: 'end' }
			})()
		let atBottom = `(() => { let t = document.querySelector('.Transcript'); return t.scrollHeight - t.clientHeight - t.scrollTop <= 1 })()`
		await b.waitFor(
			`(() => { let t = document.querySelector('textarea'); t.value = 'go'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return !document.querySelector('#notice').textContent })()`,
		)
		await b.waitFor(`document.querySelector('.activity')?.textContent.includes('idle') && ${atBottom}`)
		// Let the turn's last redraw land, so nothing else pulls the view.
		await b.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`)
		// A card tap must not leave navigation armed for a later layout shift.
		await b.evaluate(`(() => {
			let t = document.querySelector('.Transcript');
			t.dispatchEvent(new Event('touchstart', { bubbles: true }));
			t.dispatchEvent(new Event('touchend', { bubbles: true }));
			t.scrollTop -= 37;
			t.appendChild(document.createTextNode('layout update'));
		})()`)
		await b.waitFor(atBottom)
		// A style change is not a DOM mutation and fires no scroll event.
		// Two frames later the view must be back, not left short until
		// some later change happens to pull it.
		let grown = await b.evaluate(`new Promise((r) => {
			document.querySelector('.Transcript > .Card:last-of-type').style.minHeight = '3000px'
			requestAnimationFrame(() => requestAnimationFrame(() => r(${atBottom})))
		})`)
		expect(grown).toBe(true)
		let point = await b.evaluate(
			`(() => { let r = document.querySelector('.Transcript').getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2 } })()`,
		)
		let grow = async () => {
			await b.evaluate(
				`(() => { let c = document.querySelector('.Transcript > .Card:last-of-type'); c.style.minHeight = (c.getBoundingClientRect().height + 200) + 'px' })()`,
			)
			await b.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
			expect(await b.evaluate(atBottom)).toBe(true)
		}
		await b.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 120 })
		await grow()
		await b.evaluate(`document.querySelector('.Tabs button').focus()`)
		await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
		await b.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
		await grow()
		await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
		await b.evaluate(`document.querySelector('.cursor-line').style.display = 'none'`)
		await b.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
		await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
		await grow()
		await b.evaluate(`document.querySelector('.cursor-line').style.display = ''`)
		await b.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
		await b.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -120 })
		await b.waitFor(`!${atBottom}`)
		let reading = await b.evaluate(`document.querySelector('.Transcript').scrollTop`)
		await b.evaluate(`document.querySelector('.Transcript > .Card:last-of-type').style.minHeight = '4000px'`)
		await b.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
		expect(await b.evaluate(`document.querySelector('.Transcript').scrollTop`)).toBe(reading)
		await b.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 10000 })
		await b.waitFor(atBottom)
		await grow()
		// Composer grows and shrinks while output is pinned: no glide or
		// transient gap in any rendered frame, including an empty last row.
		let gaps = await b.evaluate(`(async () => {
			let t = document.querySelector('.Transcript'), box = document.querySelector('textarea'), gaps = []
			for (let value of ['hello', 'hello\\n', 'hello\\na', 'hello\\n', 'hello', '']) {
				box.value = value; box.dispatchEvent(new InputEvent('input', { bubbles: true }))
				for (let i = 0; i < 3; i++) {
					await new Promise(r => requestAnimationFrame(r))
					gaps.push(t.scrollHeight - t.clientHeight - t.scrollTop)
				}
			}
			return gaps
		})()`)
		expect(gaps.every((gap: number) => gap <= 1)).toBe(true)
	} finally {
		await b.close()
	}
})

// Task rha: items landing above a queued message must not push it down
// and glide it back; a bottom reader sees it stay put.
browserTest(
	'a queued message at the bottom stays still while replies stream above it',
	async () => {
		providerHome()
		let b = await browser(),
			release = () => {},
			finish = () => {}
		try {
			await server.serve()
			web.start()
			let id = tabs.create('/tmp')
			await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
			await b.call('Emulation.setDeviceMetricsOverride', {
				width: 1000,
				height: 600,
				deviceScaleFactor: 1,
				mobile: false,
			})
			await b.call('Page.navigate', { url: `${base()}/${id}` })
			await b.waitFor(`!!document.querySelector('textarea') && !!document.querySelector('.StatusRow')`)
			let go = new Promise<void>((r) => {
				release = r
			})
			let end = new Promise<void>((r) => {
				finish = r
			})
			turns.stream = () =>
				(async function* (): AsyncGenerator<StreamEvent> {
					// Enough to scroll: the queued card sits at the bottom.
					for (let i = 0; i < 30; i++) yield { type: 'text', text: `Start ${i}.\n\n` }
					yield { type: 'text', text: 'Starting.\n\n' }
					await go
					for (let i = 0; i < 30; i++) {
						yield { type: i % 2 ? 'text' : 'thinking', text: `Line ${i} text.\n\n` }
						await Bun.sleep(40)
					}
					await end
					yield { type: 'done', reason: 'end' }
				})()
			let send = (text: string, alt: boolean) =>
				`(() => { let t = document.querySelector('textarea'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: ${alt}, bubbles: true })); return !document.querySelector('#notice').textContent })()`
			await b.waitFor(send('go', false))
			await b.waitFor(`document.querySelector('.Transcript').innerText.includes('Starting.')`)
			await b.evaluate(send('later', true))
			await b.waitFor(`!!document.querySelector('.Card.queued') && !document.querySelector('.Card.pending')`)
			await Bun.sleep(400)
			await b.evaluate(`(() => {
			window.tops = []
			let frame = () => { let c = document.querySelector('.Card.queued'); if (c) { tops.push(Math.round(c.getBoundingClientRect().top)); requestAnimationFrame(frame) } }
			requestAnimationFrame(frame)
		})()`)
			release()
			await b.waitFor(`document.querySelector('.Transcript').innerText.includes('Line 29 ')`)
			await Bun.sleep(200)
			// Before the turn ends: then the queued message is delivered.
			let tops = await b.evaluate(`[...new Set(tops)]`)
			expect(tops).toHaveLength(1)
		} finally {
			release()
			finish()
			await b.close()
		}
	},
	20000,
)

browserTest(
	'a select-all survives seconds of streaming untouched',
	async () => {
		providerHome()
		let b = await browser(),
			release = () => {}
		try {
			await server.serve()
			web.start()
			let id = tabs.create('/tmp')
			await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
			await b.call('Page.navigate', { url: `${base()}/${id}` })
			await b.waitFor(`!!document.querySelector('textarea') && !!document.querySelector('.StatusRow')`)
			let finish = new Promise<void>((r) => {
				release = r
			})
			turns.stream = () =>
				(async function* (): AsyncGenerator<StreamEvent> {
					yield { type: 'thinking', text: 'planning' }
					// Alternating kinds make 80 rows, past the 40 a tab first shows.
					for (let i = 0; i < 40; i++) {
						yield { type: 'thinking', text: `step ${i}` }
						yield { type: 'text', text: `Line ${i} **bold** and \`code\`.\n\n` }
						await Bun.sleep(75)
					}
					await finish
					yield { type: 'done', reason: 'end' }
				})()
			await b.waitFor(
				`(() => { let t = document.querySelector('textarea'); t.value = 'go'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return !document.querySelector('#notice').textContent })()`,
			)
			await b.waitFor(`document.querySelector('.Transcript').innerText.includes('Line 8 ')`)
			await b.evaluate(`(() => {
			window.events = []
			let t = document.querySelector('.Transcript')
			let streaming = () => [...document.querySelectorAll('.Card.assistant')].at(-1)
			new MutationObserver((ms) => { for (let m of ms) for (let n of m.removedNodes) {
				// The cursor moves to each new card; nothing else may go.
				if (n.classList?.contains('cursor') || (m.target.isConnected && streaming()?.contains(m.target))) continue
				let html = n.outerHTML ?? n.textContent
				if ([...m.addedNodes].some((x) => (x.outerHTML ?? x.textContent) === html)) events.push('REMOUNT ' + html.slice(0, 120) + ' in ' + (m.target.className?.baseVal ?? m.target.className))
				else events.push('removed ' + String(html).slice(0, 100) + ' from ' + (m.target.className?.baseVal ?? m.target.className))
			} }).observe(t, { childList: true, subtree: true })
			document.addEventListener('selectionchange', () => { if (getSelection().isCollapsed) events.push('collapsed; focus ' + (document.activeElement?.tagName)) })
			window.scrolls = []
			t.addEventListener('scroll', () => scrolls.push(Math.round(t.scrollTop)))
			document.activeElement?.blur?.()
			document.querySelector('.Transcript').dispatchEvent(new WheelEvent('wheel', { deltaY: -1000 }))
			t.scrollTop = 0
			getSelection().selectAllChildren(document.body)
			window.length0 = getSelection().toString().length
		})()`)
			await b.waitFor(`document.querySelector('.Transcript').innerText.includes('Line 39 ')`)
			release()
			await b.waitFor(`!!document.querySelector('.cursor-line')`)
			await Bun.sleep(300)
			let out = await b.evaluate(
				`({ events: [...new Set(events)], scrolls: [...new Set(scrolls)], collapsed: getSelection().isCollapsed, grew: getSelection().toString().length >= length0 })`,
			)
			expect(out).toEqual({ events: [], scrolls: [0], collapsed: false, grew: true })
		} finally {
			release()
			await b.close()
		}
	},
	20000,
)
