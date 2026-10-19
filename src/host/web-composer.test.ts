// Browser tests of the composer: completion, queued message edits, the
// Ctrl-O dialog and prompt history.

import { expect } from 'bun:test'
import { writeFileSync } from 'fs'
import { history } from './history.ts'
import { host } from './host.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'
import { useWeb, base, until, providerHome } from './web-fixture.test.ts'
import { browser, browserTest, useChrome } from './web-chrome-fixture.test.ts'

useWeb()
useChrome()

browserTest(
	'completion dismissal follows pointer and focus without stealing choice clicks or Enter',
	async () => {
		providerHome()
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Page.navigate', { url: `${base()}/?auth=${webAuth.issue()}` })
			await b.waitFor(`!!document.querySelector('.entry .hint')?.textContent`)
			let type = async (text: string) => {
				await b.evaluate(
					`(() => { let t = document.querySelector('textarea'); t.focus(); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`,
				)
			}
			let open = async () => {
				await type('')
				await type('/c')
				await b.waitFor(`!!document.querySelector('.completions')`)
			}
			let press = (key: string) => b.call('Input.dispatchKeyEvent', { type: 'keyDown', key })
			await open()
			let choice = await b.evaluate(`document.querySelector('.completions button strong').textContent + ' '`)
			expect(await b.evaluate(`document.querySelector('.help').textContent`)).toContain('choose')
			await press('Enter')
			await b.waitFor(`!document.querySelector('.completions')`)
			expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe(choice)
			await open()
			// Keyboard focus within the popup must retain it until the click.
			await b.evaluate(`document.querySelector('.completions button').focus()`)
			expect(await b.evaluate(`!!document.querySelector('.completions')`)).toBe(true)
			await b.evaluate(`document.activeElement.click()`)
			await b.waitFor(`!document.querySelector('.completions')`)
			expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe(choice)
			// Model Safari's button default: blur the editor without focusing
			// the option. Canceled gestures must retain both menu and draft.
			for (let pointerType of ['mouse', 'touch']) {
				await open()
				let retained = await b.evaluate(`(() => {
				let box = document.querySelector('textarea'), row = document.querySelector('.completions button');
				if (row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: '${pointerType}' }))) box.blur();
				row.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: '${pointerType}' }));
				return { focused: document.activeElement === box, menu: row.isConnected, text: box.value };
			})()`)
				expect(retained).toEqual({ focused: true, menu: true, text: '/c' })
			}
			// A real touch tap still produces click after pointerdown cancellation.
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: true })
			await open()
			let point = await b.evaluate(
				`(() => { let r = document.querySelector('.completions button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`,
			)
			await b.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
			expect(
				await b.evaluate(
					`document.activeElement === document.querySelector('textarea') && !!document.querySelector('.completions')`,
				),
			).toBe(true)
			await b.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
			await b.waitFor(`!document.querySelector('.completions')`)
			expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe(choice)
			expect(history.readSync(await b.evaluate(`location.pathname.slice(1)`)).some((r) => r.type === 'user')).toBe(
				false,
			)
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
			for (let action of [
				`document.querySelector('[aria-label="Attach file"]').focus()`,
				`document.querySelector('textarea').blur()`,
				`document.querySelector('.Transcript').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }))`,
			]) {
				await open()
				await b.evaluate(action)
				await b.waitFor(`!document.querySelector('.completions')`)
				expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe('/c')
			}
			// Departure before the host reply must also suppress it.
			await type('')
			await b.evaluate(
				`(() => { let t = document.querySelector('textarea'); t.focus(); t.value = '/c'; t.dispatchEvent(new InputEvent('input', { bubbles: true })); document.querySelector('[aria-label="Attach file"]').focus() })()`,
			)
			await Bun.sleep(100)
			expect(await b.evaluate(`!!document.querySelector('.completions')`)).toBe(false)
			expect(await b.evaluate(`document.activeElement.getAttribute('aria-label')`)).toBe('Attach file')
			// Exact restart commands offer described scopes without changing Enter.
			for (let width of [390, 1280]) {
				await b.call('Emulation.setDeviceMetricsOverride', {
					width,
					height: 800,
					deviceScaleFactor: 1,
					mobile: width === 390,
				})
				for (let text of ['/restart', '/restart ']) {
					await type(text)
					await b.waitFor(`document.querySelectorAll('.completions button').length === 4`)
					expect(await b.evaluate(`document.querySelector('textarea').value`)).toBe(text)
					expect(await b.evaluate(`document.querySelector('.completions button').textContent`)).toContain('(default)')
					expect(await b.evaluate(`document.querySelector('.help').textContent`)).toContain('run')
					let bounds = await b.evaluate(
						`(() => { let r = document.querySelector('.completions').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: innerWidth }; })()`,
					)
					expect(bounds.left).toBeGreaterThanOrEqual(0)
					expect(bounds.right).toBeLessThanOrEqual(bounds.width)
					expect(bounds.top).toBeGreaterThanOrEqual(0)
					await press('Tab')
					await b.waitFor(
						`document.querySelector('textarea').value === '/restart all' && !document.querySelector('.completions')`,
					)
				}
			}
			await type('/version')
			await b.waitFor(`!!document.querySelector('.completions')`)
			expect(await b.evaluate(`document.querySelector('.help').textContent`)).toContain('run')
			await press('Enter')
			await b.waitFor(`document.querySelector('textarea').value === ''`)
		} finally {
			await b.close()
		}
	},
	15000,
)

browserTest(
	'queued message edits retain the draft and require host protection through save, cancel and reload',
	async () => {
		let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
		let ts = '2026-10-04T20:13:07.456Z'
		history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'Earlier prompt' }], ts })
		history.append(id, {
			type: 'inbox',
			id: 'queued-first',
			text: 'First queued message with a long line that wraps on phones and remains readable beside the pencil and reference.\nSecond line\nThird line\nFourth line',
			delivery: 'after-turn',
			ts,
		})
		history.append(id, { type: 'inbox', id: 'queued-last', text: 'Last queued message', delivery: 'after-turn', ts })
		history.append(id, { type: 'turn_end', status: 'paused', usage: {}, ts })
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
			await b.waitFor(`document.querySelectorAll('[aria-label="Edit queued message"]').length === 2`)
			let input = async (text: string) =>
				b.evaluate(
					`(() => { let t = document.querySelector('textarea'); t.focus(); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`,
				)
			for (let [name, width, height, touch] of [
				['portrait', 390, 800, true],
				['landscape', 844, 390, true],
				['desktop', 1200, 800, false],
			] as const) {
				await b.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch })
				await b.call('Emulation.setTouchEmulationEnabled', { enabled: touch })
				await input('My separate draft')
				let geometry = await b.evaluate(
					`(() => { let cards = [...document.querySelectorAll('.Card.queued')]; return { overflow: document.documentElement.scrollWidth > innerWidth + 1, edits: cards.map(c => { let e = c.querySelector('.edit').getBoundingClientRect(), r = c.querySelector('.link')?.getBoundingClientRect(); return { width: e.width, height: e.height, overlap: !!r && e.right > r.left + 1, within: e.bottom <= c.getBoundingClientRect().bottom + 1 }; }) }; })()`,
				)
				expect(geometry.overflow).toBe(false)
				for (let control of geometry.edits)
					expect(control).toMatchObject({ width: 44, height: 44, overlap: false, within: true })
				await b.evaluate(`document.querySelector('[aria-label="Edit queued message"]').click()`)
				await b.waitFor(
					`!!document.querySelector('.EditBar') && document.querySelector('textarea').value.startsWith('First queued')`,
				)
				// Editing locks the message, not the session; one edit at a time.
				expect(await b.evaluate(`document.querySelector('[aria-label="Continue"]').disabled`)).toBe(false)
				expect(
					await b.evaluate(
						`[document.querySelectorAll('[aria-label="Edit queued message"]').length, document.querySelector('.Card.queued').textContent.includes('being edited')]`,
					),
				).toEqual([0, true])
				expect(await b.evaluate(`document.querySelector('[aria-label="Save queued message"]').disabled`)).toBe(false)
				let screenshot = await b.call('Page.captureScreenshot', { format: 'png' })
				writeFileSync(`/tmp/hal-queue-edit-${name}.png`, Buffer.from(screenshot.result.data, 'base64'))
				await b.evaluate(`document.querySelector('.EditBar button').click()`)
				await b.waitFor(
					`!document.querySelector('.EditBar') && document.querySelector('textarea').value === 'My separate draft'`,
				)
			}
			await b.evaluate(`document.querySelector('[aria-label="Edit queued message"]').click()`)
			await b.waitFor(`document.querySelector('[aria-label="Save queued message"]')`)
			await input('Corrected first message')
			await b.evaluate(`document.querySelector('[aria-label="Save queued message"]').click()`)
			await b.waitFor(
				`!document.querySelector('.EditBar') && document.querySelector('textarea').value === 'My separate draft'`,
			)
			expect(status.inboxOf(id).map((m) => [m.id, m.text, m.ts])).toEqual([
				['queued-first', 'Corrected first message', ts],
				['queued-last', 'Last queued message', ts],
			])
			// Empty composer Up chooses the newest, not the first visible queued row.
			await input('')
			await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp' })
			await b.waitFor(`document.querySelector('textarea').value === 'Last queued message'`)
			await input('Unsaved newest edit')
			await b.call('Page.reload', {})
			await b.waitFor(
				`document.querySelector('textarea')?.value === 'Unsaved newest edit' && document.querySelector('.EditBar') && !document.querySelector('[aria-label="Save queued message"]').disabled`,
			)
			expect(status.inboxOf(id).map((m) => m.text)).toEqual(['Corrected first message', 'Last queued message'])
			await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' })
			await b.waitFor(`!document.querySelector('.EditBar') && document.querySelector('textarea').value === ''`)
			expect(status.stateOf(id).type).toBe('paused')
		} finally {
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
			await b.close()
		}
	},
	20000,
)

browserTest(
	'the Ctrl-O dialog is as tall as its content, hints live, completes with Tab and expands',
	async () => {
		let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
		history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'prompt' }] })
		let calls = [0, 1, 2].map(
			(k) =>
				history.append(id, {
					type: 'assistant',
					block: {
						type: 'tool_call',
						id: `c${k}`,
						name: 'bash',
						input: { command: `echo ${k}`, description: `Say ${k}` },
					},
				}).n,
		)
		history.append(id, {
			type: 'user',
			blocks: [0, 1, 2].map((k) => ({ type: 'tool_result' as const, id: `c${k}`, output: `out ${k}` })),
		})
		history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
		let b = await browser()
		try {
			await server.serve()
			web.start()
			for (let width of [390, 1280]) {
				await b.call('Emulation.setTouchEmulationEnabled', { enabled: width === 390 })
				await b.call('Emulation.setDeviceMetricsOverride', {
					width,
					height: 800,
					deviceScaleFactor: 1,
					mobile: width === 390,
				})
				await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
				await b.waitFor(`document.querySelectorAll('.Card.folds').length >= 3`)
				await b.call('Input.dispatchKeyEvent', {
					type: 'keyDown',
					key: 'o',
					code: 'KeyO',
					windowsVirtualKeyCode: 79,
					modifiers: 2,
				})
				await b.waitFor(
					`document.querySelector('.Picker.compact[open] .blocks-hint')?.textContent === 'Expand latest tool card t${calls[2]} (the default)'`,
				)
				let box = await b.evaluate(
					`(() => { let d = document.querySelector('.Picker.compact'), r = d.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height, fits: d.scrollHeight <= d.clientHeight && d.scrollWidth <= d.clientWidth, width: innerWidth } })()`,
				)
				expect(box.left).toBeGreaterThanOrEqual(0)
				expect(box.right).toBeLessThanOrEqual(box.width)
				expect(box.fits).toBe(true)
				await b.call('Input.insertText', { text: 't' })
				await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
				await b.waitFor(`document.querySelectorAll('.Picker .blocks-ids li').length === 3`)
				expect(
					await b.evaluate(`[...document.querySelectorAll('.Picker .blocks-ids li')].map((l) => l.textContent)`),
				).toEqual([...calls].reverse().map((n) => `t${n}`))
				await b.call('Input.insertText', { text: '*' })
				await b.waitFor(
					`document.querySelector('.Picker .blocks-hint')?.textContent === 'Expand 3 tool cards: ${calls.map((n) => `t${n}`).join(', ')}'`,
				)
				await b.call('Input.dispatchKeyEvent', {
					type: 'keyDown',
					key: 'Enter',
					code: 'Enter',
					windowsVirtualKeyCode: 13,
				})
				await b.waitFor(
					`document.querySelectorAll('.Card.folds.open').length === 3 && !document.querySelector('.Picker[open]')`,
				)
			}
		} finally {
			await b.call('Emulation.setTouchEmulationEnabled', { enabled: false })
			await b.close()
		}
	},
	20000,
)

browserTest(
	'composer history skips agents and remains navigable after native deletion and undo',
	async () => {
		let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
		for (let text of ['first', 'second', 'third'])
			history.append(id, { type: 'user', blocks: [{ type: 'text', text }] })
		history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'not human', from: 'other' }] })
		history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
			await b.waitFor(`document.querySelector('textarea') && document.querySelector('.Card')`)
			await b.evaluate(`document.querySelector('textarea').focus()`)
			let press = (key: string) =>
				b.call('Input.dispatchKeyEvent', {
					type: 'keyDown',
					key,
					windowsVirtualKeyCode: key === 'Backspace' ? 8 : key === 'ArrowUp' ? 38 : 40,
				})
			let value = () => b.evaluate(`document.querySelector('textarea').value`)
			for (let restore of ['delete', 'undo']) {
				await press('ArrowUp')
				expect(await value()).toBe('third')
				await press('ArrowUp')
				expect(await value()).toBe('second')
				await b.call('Input.insertText', { text: '!' })
				expect(await value()).toBe('second!')
				if (restore === 'delete') await press('Backspace')
				else await b.evaluate(`document.execCommand('undo')`)
				expect(await value()).toBe('second')
				await press('ArrowUp')
				expect(await value()).toBe('first')
				for (let i = 0; i < 3; i++) await press('ArrowDown')
				expect(await value()).toBe('second')
				await b.evaluate(
					`(() => { let t = document.querySelector('textarea'); t.value = ''; t.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`,
				)
			}
		} finally {
			await b.close()
		}
	},
	15000,
)
