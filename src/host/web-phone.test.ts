// Browser tests at phone sizes: Nudge, landscape drafts, question links
// and open bodies under taps.

import { expect } from 'bun:test'
import { writeFileSync } from 'fs'
import { history } from './history.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'
import { testHome, useWeb, base, providerHome } from './web-fixture.test.ts'
import { browser, browserTest, useChrome } from './web-chrome-fixture.test.ts'

useWeb()
useChrome()

browserTest(
	'mobile disabled Nudge slides behind Send without replacing the editor',
	async () => {
		providerHome()
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Page.navigate', { url: `${base()}/?auth=${webAuth.issue()}` })
			await b.waitFor(
				'document.querySelector(\'[aria-label="Nudge"]\') && !document.querySelector(\'[aria-label="Nudge"]\').disabled',
			)
			let input = (text: string) =>
				b.evaluate(
					`(() => { let t = document.querySelector('textarea'); t.focus(); t.value = ${JSON.stringify(text)}; t.setSelectionRange(1, 1); t.dispatchEvent(new Event('input', { bubbles: true })); })()`,
				)
			let geometry = () =>
				b.evaluate(`(() => {
			let q = s => document.querySelector(s), rect = s => q(s).getBoundingClientRect().toJSON();
			return { nudge: rect('.toggle'), send: rect('.go'), field: rect('.field'), entry: rect('.entry'), same: q('textarea') === window.oldEditor, focused: document.activeElement === q('textarea'), cursor: q('textarea').selectionStart, disabled: q('.toggle').disabled, front: document.elementFromPoint(rect('.go').x + 22, rect('.go').y + 22)?.closest('button') === q('.go'), opaque: getComputedStyle(q('.go')).backgroundColor === getComputedStyle(q('.entry')).backgroundColor };
		})()`)
			for (let [width, height, touch] of [
				[390, 760, true],
				[844, 390, true],
				[1280, 800, false],
			] as const) {
				await b.call('Emulation.setTouchEmulationEnabled', { enabled: touch })
				await b.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch })
				await b.waitFor(`Math.abs(document.querySelector('.App').getBoundingClientRect().height - ${height}) < 2`)
				await input('')
				await b.waitFor(
					"document.querySelector('.toggle').getBoundingClientRect().right <= document.querySelector('.go').getBoundingClientRect().left + 1",
				)
				await b.evaluate("window.oldEditor = document.querySelector('textarea')")
				let before = await geometry()
				await input('draft')
				if (touch)
					await b.waitFor(
						"document.querySelector('.actions').classList.contains('tucked') && document.querySelector('.toggle').getAnimations().length === 0",
					)
				let after = await geometry()
				expect(after).toMatchObject({ same: true, focused: true, cursor: 1, disabled: true })
				if (touch) {
					expect(after.field.width - before.field.width).toBeCloseTo(44, 0)
					expect(after.nudge.left).toBeCloseTo(after.send.left, 0)
					expect(after.nudge.top).toBe(after.send.top)
					expect(after.entry.height).toBe(before.entry.height)
					expect(after).toMatchObject({ front: true, opaque: true })
				} else expect(after.field.width).toBe(before.field.width)
				await input('first line\nsecond line\nthird line')
				let tall = await geometry()
				expect(tall.same).toBe(true)
				if (touch) expect([tall.send.top, tall.send.bottom]).toEqual([tall.entry.top, tall.entry.bottom])
				if (touch) {
					let screenshot = await b.call('Page.captureScreenshot', { format: 'png' })
					writeFileSync(`/tmp/hal-nudge-${width}.png`, Buffer.from(screenshot.result.data, 'base64'))
				}
			}
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
			await b.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
			expect(await b.evaluate("getComputedStyle(document.querySelector('.toggle')).transitionDuration")).toBe('0s')
		} finally {
			await b.call('Emulation.setEmulatedMedia', { features: [] })
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
			await b.close()
		}
	},
	20_000,
)

browserTest(
	'phone landscape shrinks chrome and bounds long drafts as the visible viewport changes',
	async () => {
		providerHome()
		let b = await browser()
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
			await b.call('Page.navigate', { url: `${base()}/?auth=${webAuth.issue()}` })
			await b.waitFor(
				"document.querySelector('textarea') && document.querySelector('.StatusRow .name')?.textContent.includes('Session ')",
			)
			let draft = Array.from({ length: 30 }, (_, i) => `Draft line ${i}: preserve this text`).join('\n')
			await b.evaluate(
				`let t = document.querySelector('textarea'); t.value = ${JSON.stringify(draft)}; t.dispatchEvent(new Event('input', { bubbles: true }))`,
			)
			let geometry = (height?: number) =>
				b.evaluate(`(() => {
			${height ? `document.documentElement.style.setProperty('--app-height', '${height}px');` : ''}
			let q = s => document.querySelector(s), rect = s => q(s).getBoundingClientRect(), font = s => parseFloat(getComputedStyle(q(s)).fontSize);
			return { transcriptFont: font('.Transcript'), statusFont: font('.overview'), draftFont: font('textarea'), draftHeight: rect('textarea').height, scrollable: q('textarea').scrollHeight > q('textarea').clientHeight, transcriptHeight: rect('.Transcript').height, targets: [...document.querySelectorAll('.overview, .entry button')].every(e => e.getBoundingClientRect().height >= 44), overflow: document.documentElement.scrollWidth > innerWidth, value: q('textarea').value };
		})()`)
			let portrait = await geometry()
			expect(portrait.transcriptFont).toBe(14)
			expect(portrait.statusFont).toBeGreaterThan(11)
			expect(portrait.draftHeight).toBeGreaterThan(80)
			for (let [width, height] of [
				[844, 390],
				[667, 375],
			]) {
				await b.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
				let landscape = await geometry()
				expect(landscape.transcriptFont).toBe(12)
				expect(landscape.statusFont).toBe(11)
				expect(landscape.draftFont).toBe(16)
				expect(landscape.draftHeight).toBeLessThanOrEqual(80)
				expect(landscape.scrollable).toBe(true)
				expect(landscape.transcriptHeight).toBeGreaterThan(100)
				expect(landscape.targets).toBe(true)
				expect(landscape.overflow).toBe(false)
				expect(landscape.value).toBe(draft)
			}
			// Model the visible space left by a keyboard without changing the draft.
			let keyboard = await geometry(180)
			expect(keyboard.draftHeight).toBeLessThanOrEqual(45)
			expect(keyboard.transcriptHeight).toBeGreaterThan(10)
			expect(keyboard.value).toBe(draft)
			await b.call('Emulation.setDeviceMetricsOverride', {
				width: 390,
				height: 760,
				deviceScaleFactor: 1,
				mobile: true,
			})
			await b.waitFor("document.querySelector('.App').getBoundingClientRect().height >= 750")
			expect((await geometry()).draftHeight).toBeGreaterThan(80)
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
			await b.call('Emulation.setDeviceMetricsOverride', {
				width: 844,
				height: 390,
				deviceScaleFactor: 1,
				mobile: false,
			})
			let desktop = await geometry()
			expect(desktop.transcriptFont).toBe(14)
			expect(desktop.statusFont).toBe(portrait.statusFont)
		} finally {
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
			await b.close()
		}
	},
	20000,
)

browserTest('pending question URLs are safe native links and wrap at phone and desktop widths', async () => {
	let id = sessions.create({ cwd: testHome(), model: 'anthropic/claude-opus-5-5' }).id
	let url = `https://example.com/oauth?state=a_b&redirect_uri=https%3A%2F%2Fexample.org%2Fcallback&scope=${'user%3Aprofile+'.repeat(30)}#fragment`
	let text = `Open (${url}) and sign in with the account you use for this provider.\nThen paste code#state. <script>window.pwned=1</script> javascript:bad()`
	history.append(id, {
		type: 'question',
		id: 'q-links',
		form: {
			text,
			fields: [
				{ type: 'text', name: 'code' },
				{ type: 'choice', name: 'mode', options: ['Continue', 'Cancel'] },
			],
		},
		from: { command: 'login', args: '' },
	})
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
		await b.waitFor(`!!document.querySelector('.Question .label a')`)
		let link = await b.evaluate(
			`(() => { let q = document.querySelector('.Question'), a = q.querySelector('.label a'); return { href: a.getAttribute('href'), target: a.target, rel: a.rel, text: q.querySelector('.label').textContent, details: q.querySelector('.details')?.textContent, links: q.querySelectorAll('a').length, scripts: q.querySelectorAll('script').length } })()`,
		)
		expect(link).toEqual({ href: url, target: '_blank', rel: 'noopener noreferrer', text: text.split('\n')[0], details: text.split('\n')[1], links: 2, scripts: 0 })
		for (let width of [390, 1280]) {
			await b.call('Emulation.setDeviceMetricsOverride', {
				width,
				height: 800,
				deviceScaleFactor: 1,
				mobile: width === 390,
			})
			await b.evaluate(`new Promise(resolve => requestAnimationFrame(resolve))`)
			expect(
				await b.evaluate(
					`(() => { let q = document.querySelector('.Question'); return q.scrollWidth <= q.clientWidth && document.documentElement.scrollWidth <= innerWidth })()`,
				),
			).toBe(true)
			// A wrapped question continues at the left edge, under its time, as in the terminal.
			expect(
				await b.evaluate(
					`(() => { let h = document.querySelector('.Question .CardHeader'), rects = [...h.querySelector('.title .label').getClientRects()]; return Math.abs(rects.at(-1).left - h.querySelector('.stamp').getBoundingClientRect().left) })()`,
				),
			).toBeLessThanOrEqual(1)
		}
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
		await b.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
		expect(
			await b.evaluate(
				`[...document.querySelectorAll('.Question button')].every(b => b.getBoundingClientRect().height >= 44 && b.getBoundingClientRect().width >= 44)`,
			),
		).toBe(true)
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
		await b.evaluate(`document.querySelector('.Question input').focus()`)
		for (let selector of ['a.link', '.dismiss', '.label a']) {
			await b.call('Input.dispatchKeyEvent', {
				type: 'keyDown',
				key: 'Tab',
				code: 'Tab',
				windowsVirtualKeyCode: 9,
				modifiers: 8,
			})
			await b.call('Input.dispatchKeyEvent', {
				type: 'keyUp',
				key: 'Tab',
				code: 'Tab',
				windowsVirtualKeyCode: 9,
				modifiers: 8,
			})
			expect(await b.evaluate(`document.activeElement === document.querySelector('.Question ${selector}')`)).toBe(true)
		}
		expect(history.readSync(id).some((r) => r.type === 'answer')).toBe(false)
	} finally {
		await b.close()
	}
})

browserTest(
	'assistant and completion bodies stay open through selection taps at phone and desktop widths',
	async () => {
		let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
		history.append(id, {
			type: 'user',
			blocks: [
				{
					type: 'text',
					label: 'bash #t1',
					from: id,
					advisory: true,
					delivery: 'next-round',
					text: '[exit 0]\n' + Array.from({ length: 80 }, (_, i) => `output line ${i}`).join('\n'),
				},
			],
		})
		history.append(id, {
			type: 'assistant',
			block: { type: 'text', text: 'Select this answer.\n\nTap outside the selection to keep reading.' },
		})
		let b = await browser()
		await b.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
		try {
			await server.serve()
			web.start()
			await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
			await b.waitFor(`!!document.querySelector('.Card.background-result .mark')`)
			expect(
				await b.evaluate(
					`!!document.querySelector('.Card.background-result [title^="Read by Hal"], .Card.background-result [title^="Delivered, not read"]')`,
				),
			).toBe(false)
			expect(
				await b.evaluate(`document.querySelector('.Card.background-result .mark').getAttribute('aria-expanded')`),
			).toBe('false')
			for (let width of [390, 1200]) {
				await b.call('Emulation.setDeviceMetricsOverride', {
					width,
					height: 800,
					deviceScaleFactor: 1,
					mobile: width === 390,
				})
				await b.call('Emulation.setTouchEmulationEnabled', { enabled: width === 390, maxTouchPoints: 1 })
				let tap = async (selector: string) => {
					if (width !== 390) {
						await b.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
						return
					}
					let point = (await b.evaluate(
						`(() => { let el = document.querySelector(${JSON.stringify(selector)}); (el.closest('.CardHeader') ? el.closest('.Card') : el).scrollIntoView({block:'nearest'}); let r = el.getClientRects()[0] ?? el.getBoundingClientRect(), header = el.closest('.Card').querySelector('.CardHeader').getBoundingClientRect(), inset = Math.min(40, r.height / 2); let point = {x:r.left+r.width/2,y:Math.max(inset,r.top+inset,el.closest('.CardHeader') ? 0 : header.bottom+inset)}; if (!document.elementFromPoint(point.x, point.y)?.closest(${JSON.stringify(selector)})) throw new Error('Tap misses ' + ${JSON.stringify(selector)}); return point })()`,
					)) as { x: number; y: number }
					await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
					await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
				}
				await tap('.Card.background-result .CardHeader .label')
				await b.waitFor(
					`document.querySelector('.Card.background-result .mark').getAttribute('aria-expanded') === 'true'`,
				)
				expect(await b.evaluate(`document.querySelector('.Card.background-result .body').inert`)).toBe(false)
				await tap('.Card.background-result .content')
				expect(
					await b.evaluate(`document.querySelector('.Card.background-result .mark').getAttribute('aria-expanded')`),
				).toBe('true')
				await b.evaluate(
					`(() => { let range = document.createRange(); range.selectNodeContents(document.querySelector('.Card.background-result .content')); getSelection().addRange(range); })()`,
				)
				await tap('.Card.background-result .content')
				expect(
					await b.evaluate(`document.querySelector('.Card.background-result .mark').getAttribute('aria-expanded')`),
				).toBe('true')
				await b.evaluate(`getSelection().removeAllRanges()`)
				await tap('.Card.background-result .content')
				expect(
					await b.evaluate(`document.querySelector('.Card.background-result .mark').getAttribute('aria-expanded')`),
				).toBe('true')
				await tap('.Card.background-result .CardHeader .label')
				await b.waitFor(
					`document.querySelector('.Card.background-result .mark').getAttribute('aria-expanded') === 'false'`,
				)
				expect(await b.evaluate(`document.querySelector('.Card.background-result .body').inert`)).toBe(true)
				await tap('.Card.assistant .CardHeader .label')
				await b.waitFor(`document.querySelector('.Card.assistant .mark').getAttribute('aria-expanded') === 'false'`)
				await b.evaluate(`document.querySelector('.Card.assistant .mark').click()`)
				await b.waitFor(`document.querySelector('.Card.assistant .mark').getAttribute('aria-expanded') === 'true'`)
				await b.evaluate(
					`(() => { let range = document.createRange(); range.selectNodeContents(document.querySelector('.Card.assistant .content')); getSelection().addRange(range); })()`,
				)
				await tap('.Card.assistant .content')
				expect(await b.evaluate(`document.querySelector('.Card.assistant .mark').getAttribute('aria-expanded')`)).toBe(
					'true',
				)
				await b.evaluate(`getSelection().removeAllRanges()`)
				await tap('.Card.assistant .content')
				expect(await b.evaluate(`document.querySelector('.Card.assistant .mark').getAttribute('aria-expanded')`)).toBe(
					'true',
				)
			}
		} finally {
			await b.close()
		}
	},
)
