// Browser tests of touch input: tab navigation, Send taps and the touch
// debug log.

import { expect } from 'bun:test'
import { history } from './history.ts'
import { server } from './server.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'
import { testHome, useWeb, base, providerHome } from './web-fixture.test.ts'
import { browser, browserTest, useChrome } from './web-chrome-fixture.test.ts'

useWeb()
useChrome()

browserTest('touch tab navigation does not focus the composer', async () => {
	providerHome()
	let b = await browser()
	try {
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
		await server.serve()
		web.start()
		await b.call('Page.navigate', { url: `${base()}/?auth=${webAuth.issue()}` })
		await b.waitFor(`document.querySelector('textarea') && document.querySelector('.Tabs .strip [aria-current]')`)
		expect(await b.evaluate(`matchMedia('(pointer: coarse)').matches`)).toBe(true)
		expect(await b.evaluate(`document.activeElement === document.querySelector('textarea')`)).toBe(false)
		let first = await b.evaluate('location.pathname')
		// A question owns focus in this tab. Leaving it used to refocus the
		// composer as soon as the next tab had no question.
		await b.evaluate(
			`(() => { let t = document.querySelector('textarea'); t.focus(); t.value = '/cd ${testHome()}/missing'; t.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`,
		)
		expect(await b.evaluate(`document.activeElement === document.querySelector('textarea')`)).toBe(true)
		await b.evaluate(`document.querySelector('.Composer .actions .go').click()`)
		await b.waitFor(`document.querySelector('textarea').disabled`)
		await b.evaluate(`document.querySelector('.Tabs .strip .new').click()`)
		await b.waitFor(
			`location.pathname !== '${first}' && document.querySelector('textarea') && !document.querySelector('textarea').disabled`,
		)
		expect(await b.evaluate(`document.activeElement === document.querySelector('textarea')`)).toBe(false)
		let second = await b.evaluate('location.pathname')
		await b.evaluate(`document.querySelector('.Tabs .strip a[href="${first}"]').click()`)
		await b.waitFor(`location.pathname === '${first}' && document.querySelector('textarea').disabled`)
		await b.evaluate(`document.querySelector('.Tabs .strip a[href="${second}"]').click()`)
		await b.waitFor(`location.pathname === '${second}' && !document.querySelector('textarea').disabled`)
		expect(await b.evaluate(`document.activeElement === document.querySelector('textarea')`)).toBe(false)
		await b.evaluate(`document.querySelector('textarea').focus()`)
		expect(await b.evaluate(`document.activeElement === document.querySelector('textarea')`)).toBe(true)
	} finally {
		await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
		await b.close()
	}
})

browserTest(
	'a touch on Send sends once, even when iOS withholds the click',
	async () => {
		providerHome()
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
			await b.call('Page.navigate', { url: `${base()}/?auth=${webAuth.issue()}` })
			await b.waitFor(`!!document.querySelector('.entry .hint')?.textContent`)
			let draft = (text: string) =>
				b.evaluate(
					`(() => { let box = document.querySelector('textarea'); box.focus(); box.value = '${text}'; box.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`,
				)
			let prompts = async () =>
				history.readSync(await b.evaluate(`location.pathname.slice(1)`)).filter((r) => r.type === 'user').length
			await draft('first')
			await b.waitFor(`!document.querySelector('.Composer .go').disabled`)
			let point = await b.evaluate(
				`(() => { let r = document.querySelector('.Composer .go').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
			)
			await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
			await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
			await b.waitFor(`document.querySelector('textarea').value === ''`)
			await Bun.sleep(300)
			expect(await prompts()).toBe(1)
			// iOS: pointerdown and pointerup inside Send, then no click.
			await draft('second')
			await b.waitFor(`!document.querySelector('.Composer .go').disabled`)
			await b.evaluate(
				`(() => { let go = document.querySelector('.Composer .go'), init = { bubbles: true, cancelable: true, pointerType: 'touch', clientX: ${point.x}, clientY: ${point.y} }; go.dispatchEvent(new PointerEvent('pointerdown', init)); go.dispatchEvent(new PointerEvent('pointerup', init)) })()`,
			)
			await b.waitFor(`document.querySelector('textarea').value === ''`)
			await Bun.sleep(300)
			expect(await prompts()).toBe(2)
			// The compatibility click can land on a different control after
			// sending changes the layout. It belongs to Send, not that control.
			await draft('third')
			await b.waitFor(`!document.querySelector('.Composer .go').disabled`)
			await b.evaluate(`(() => {
			let go = document.querySelector('.Composer .go'), r = go.getBoundingClientRect(), init = { bubbles: true, cancelable: true, pointerType: 'touch', clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
			go.dispatchEvent(new PointerEvent('pointerdown', init)); go.dispatchEvent(new PointerEvent('pointerup', init));
			document.querySelector('.details-target').dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
		})()`)
			expect(await b.evaluate(`document.querySelector('.StatusDetails').open`)).toBe(false)
			await b.waitFor(`document.querySelector('textarea').value === ''`)
			expect(await prompts()).toBe(3)
		} finally {
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
			await b.close()
		}
	},
	15000,
)

browserTest(
	'local touch debug is opt-in, observes canceled taps, and never consumes Send',
	async () => {
		providerHome()
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
			await b.call('Page.navigate', { url: `${base()}/?auth=${webAuth.issue()}` })
			await b.waitFor(`!!document.querySelector('.entry .hint')?.textContent`)
			expect(await b.evaluate(`!!document.querySelector('.TouchDebug')`)).toBe(false)
			expect(await b.evaluate(`localStorage.getItem('hal.touch-debug.log')`)).toBe(null)
			let toggle = async () => {
				await b.evaluate(`document.querySelector('[aria-label="All tabs"]').click()`)
				await b.waitFor(`document.querySelector('.Tabs dialog').open`)
				await b.evaluate(
					`new Promise(resolve => { document.querySelector('.Tabs dialog').addEventListener('close', resolve, { once: true }); [...document.querySelectorAll('.Tabs dialog button')].find(b => b.textContent.includes('Touch debug')).click(); })`,
				)
				await b.waitFor(`!document.querySelector('.Tabs dialog').open`)
			}
			await toggle()
			await b.evaluate(
				`(() => { let box = document.querySelector('textarea'); box.focus(); box.value = '/help'; box.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`,
			)
			await b.waitFor(`!document.querySelector('.Composer .go').disabled`)
			let point = await b.evaluate(
				`(() => { let r = document.querySelector('.Composer .go').getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`,
			)
			await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
			await b.waitFor(`document.querySelector('.TouchDebug').textContent.includes('touchstart Run')`)
			expect(await b.evaluate(`document.querySelector('.TouchDebug').textContent`)).toContain('pointerdown Run')
			expect(await b.evaluate(`document.querySelector('.TouchDebug').textContent`)).toContain('prevented')
			expect(
				await b.evaluate(`document.elementFromPoint(${point.x}, ${point.y}).closest('.Composer .go') !== null`),
			).toBe(true)
			expect(await b.evaluate(`getComputedStyle(document.querySelector('.TouchCrosshair')).display`)).toBe('none')
			expect(await b.evaluate(`getComputedStyle(document.querySelector('.TouchDebug')).display`)).toBe('none')
			await b.call('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
			expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe('/help')
			await b.waitFor(`document.querySelector('.TouchDebug').textContent.includes('touchcancel')`)
			expect(await b.evaluate(`document.querySelector('.TouchDebug').textContent`)).toContain('touchcancel')
			await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
			await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
			await b.waitFor(`document.querySelector('textarea').value === ''`)
			await b.waitFor(`document.querySelector('.TouchDebug').textContent.includes('pointerup Run')`)
			let output = await b.evaluate(`document.querySelector('.TouchDebug').textContent`)
			expect(output).not.toContain('/help')
			expect(output).not.toContain('send:absent')
			await b.evaluate(
				`(() => { let box = document.querySelector('textarea'); box.value = 'private caret text'; box.dispatchEvent(new InputEvent('input', { bubbles: true })); box.setSelectionRange(3, 7); box.dispatchEvent(new Event('selectionchange', { bubbles: true })); })()`,
			)
			await b.waitFor(`document.querySelector('.TouchDebug').textContent.includes('caret:3,7')`)
			expect(await b.evaluate(`document.querySelector('.TouchDebug').textContent`)).not.toContain('private caret text')
			await b.evaluate(`document.querySelector('.Tabs .strip .new').click()`)
			await b.waitFor(
				`document.querySelectorAll('.Tabs .track a.tab').length === 2 && document.querySelector('.Tabs .strip [aria-current] .n').textContent === '2'`,
			)
			await b.evaluate(`document.querySelector('.Tabs .track a.tab .n').click()`)
			await b.waitFor(
				`document.querySelector('.TouchDebug').textContent.includes('click tab:1') && document.querySelector('.TouchDebug').textContent.includes('tab:1 url:1 dom:1')`,
			)
			output = await b.evaluate(`document.querySelector('.TouchDebug').textContent`)
			expect(output).toContain('tab:2 url:2 dom:2') // event-time state before the handler
			expect(output).not.toContain(await b.evaluate(`location.pathname.slice(1)`))
			await b.evaluate(
				`window.dispatchEvent(new ErrorEvent('error', { error: new DOMException('private error text', 'SecurityError'), lineno: 12, colno: 34 }))`,
			)
			output = await b.evaluate(`document.querySelector('.TouchDebug').textContent`)
			expect(output).toContain('error SecurityError line:12 col:34')
			expect(output).not.toContain('private error text')
			await b.evaluate(
				`window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: new TypeError('private rejection text') }))`,
			)
			expect(await b.evaluate(`document.querySelector('.TouchDebug').textContent`)).toContain('rejection TypeError')
			expect(await b.evaluate(`document.querySelector('.TouchDebug').textContent`)).not.toContain(
				'private rejection text',
			)
			await b.evaluate(
				`for (let i = 0; i < 20; i++) window.dispatchEvent(new ErrorEvent('error', { error: new RangeError('not captured'), lineno: i }))`,
			)
			expect(await b.evaluate(`document.querySelector('.TouchDebug').textContent`)).not.toContain('pointerup Run')
			await toggle()
			expect(
				await b.evaluate(`!!document.querySelector('.TouchDebug') || !!document.querySelector('.TouchCrosshair')`),
			).toBe(false)
			let saved = await b.evaluate(`localStorage.getItem('hal.touch-debug.log')`)
			expect(saved).toContain('pointerup Run')
			expect(saved).toContain('touchcancel')
			expect(saved).not.toContain('/help')
			expect(saved).not.toContain('private error text')
			await toggle()
			expect(await b.evaluate(`document.querySelectorAll('.TouchDebug').length`)).toBe(1)
			await b.evaluate(
				`for (let i = 0; i < 310; i++) window.dispatchEvent(new ErrorEvent('error', { error: new RangeError('not captured'), lineno: i }))`,
			)
			await toggle()
			expect(await b.evaluate(`JSON.parse(localStorage.getItem('hal.touch-debug.log')).length`)).toBe(300)
			await b.call('Page.reload', {})
			await b.waitFor(`!!document.querySelector('.StatusRow .model')?.textContent`)
			expect(await b.evaluate(`!!document.querySelector('.TouchDebug')`)).toBe(false)
			let inspect = async () => {
				await b.evaluate(`document.querySelector('[aria-label="All tabs"]').click()`)
				await b.waitFor(`document.querySelector('.Tabs dialog').open`)
				await b.evaluate(
					`[...document.querySelectorAll('.Tabs dialog button')].find(b => b.textContent === 'Touch debug logs').click()`,
				)
				await b.waitFor(`document.querySelector('.TouchHistory')?.open && !document.querySelector('.Tabs dialog').open`)
			}
			await inspect()
			output = await b.evaluate(`document.querySelector('.TouchHistory pre').textContent`)
			expect(output).toContain('error RangeError line:309')
			expect(output).toContain('after tab:')
			expect(output).not.toContain('not captured')
			expect(await b.evaluate(`document.querySelector('.TouchHistory').scrollWidth <= innerWidth`)).toBe(true)
			await b.evaluate(
				`(() => { let box = document.querySelector('textarea'); box.value = 'existing draft'; box.dispatchEvent(new InputEvent('input', { bubbles: true })); [...document.querySelectorAll('.TouchHistory button')].find(b => b.textContent === 'Paste logs').click(); })()`,
			)
			await b.waitFor(
				`!document.querySelector('.TouchHistory') && document.querySelector('textarea').value.startsWith('existing draft\\n\\nTouch debug logs:')`,
			)
			expect(await b.evaluate(`document.querySelector('textarea').value`)).toContain('error RangeError line:309')
			expect(await b.evaluate(`document.querySelector('textarea').value`)).not.toContain('not captured')
			await inspect()
			await b.evaluate(
				`[...document.querySelectorAll('.TouchHistory button')].find(b => b.textContent === 'Clear logs').click()`,
			)
			expect(await b.evaluate(`localStorage.getItem('hal.touch-debug.log')`)).toBe(null)
			expect(await b.evaluate(`document.querySelector('.TouchHistory pre').textContent`)).toBe('No recorded events.')
			expect(
				await b.evaluate(
					`[...document.querySelectorAll('.TouchHistory button')].find(b => b.textContent === 'Paste logs').disabled`,
				),
			).toBe(true)
			await b.evaluate(
				`[...document.querySelectorAll('.TouchHistory button')].find(b => b.textContent === 'Close').click()`,
			)
			await b.waitFor(`!document.querySelector('.TouchHistory')`)
			await inspect()
			expect(await b.evaluate(`document.querySelector('.TouchHistory pre').textContent`)).toContain(
				'No recorded events.',
			)
			await b.evaluate(
				`[...document.querySelectorAll('.TouchHistory button')].find(b => b.textContent === 'Close').click()`,
			)
			await b.waitFor(`!document.querySelector('.TouchHistory')`)
			await toggle()
			await b.evaluate(
				`window.originalSetItem = Storage.prototype.setItem; window.originalAlert = window.alert; window.alert = message => { window.storageWarning = message }; Storage.prototype.setItem = () => { throw new DOMException('storage full', 'QuotaExceededError') }; window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('not captured'), lineno: 777 }))`,
			)
			await b.waitFor(`!!window.storageWarning`)
			expect(await b.evaluate(`window.storageWarning`)).toContain('QuotaExceededError: storage full')
			await toggle()
			await inspect()
			output = await b.evaluate(`document.querySelector('.TouchHistory pre').textContent`)
			expect(output).toContain('could not be saved')
			expect(output).toContain('error TypeError line:777')
			await b.evaluate(`Storage.prototype.setItem = window.originalSetItem; window.alert = window.originalAlert`)
		} finally {
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
			await b.close()
		}
	},
	20000,
)
