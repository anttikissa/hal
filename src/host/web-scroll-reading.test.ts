// Checks that content reflow leaves the text being read at the same position.
import { expect } from 'bun:test'
import type { StreamEvent } from '../common/blocks.ts'
import { tabs } from './tabs.ts'
import { turns } from './turns.ts'
import { server } from './server.ts'
import { web } from './web.ts'
import { useWeb, base, cookie, providerHome } from './web-fixture.test.ts'
import { browser, browserTest, useChrome } from './web-chrome-fixture.test.ts'

useWeb()
useChrome()

browserTest(
	'an unpinned reader keeps the same text through content layout changes',
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
				width: 1200,
				height: 800,
				deviceScaleFactor: 1,
				mobile: false,
			})
			await b.call('Page.navigate', { url: `${base()}/${id}` })
			await b.waitFor(`!!document.querySelector('textarea') && !!document.querySelector('.StatusRow')`)
			let advance = new Promise<void>((r) => {
					release = r
				}),
				end = new Promise<void>((r) => {
					finish = r
				})
			turns.stream = () =>
				(async function* (): AsyncGenerator<StreamEvent> {
					yield {
						type: 'text',
						text:
							'| Key | Description |\n|---|---|\n' +
							Array.from(
								{ length: 50 },
								(_, i) => `| Row ${i} | ${'A description with several words. '.repeat(6)} |`,
							).join('\n') +
							'\n',
					}
					await advance
					yield { type: 'text', text: `| ${'W'.repeat(60)} | Last row |\n\nFinished table.` }
					await end
					yield { type: 'done', reason: 'end' }
				})()
			await b.waitFor(
				`(() => { let t = document.querySelector('textarea'); t.value = 'go'; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return !document.querySelector('#notice').textContent })()`,
			)
			await b.waitFor(`document.querySelector('.Transcript')?.innerText.includes('Row 48')`)
			await b.evaluate(`(async () => {
				let t = document.querySelector('.Transcript');
				window.reading = [...t.querySelectorAll('td span')].find(e => e.textContent === 'Row 25');
				t.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
				t.scrollTop += reading.getBoundingClientRect().top - t.getBoundingClientRect().top - t.clientHeight / 2;
				t.dispatchEvent(new Event('scroll'));
				await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
				window.readingTop = reading.getBoundingClientRect().top;
			})()`)
			release()
			await b.waitFor(`document.querySelector('.Transcript')?.innerText.includes('Finished table.')`)
			await b.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
			expect(await b.evaluate(`Math.abs(reading.getBoundingClientRect().top - readingTop)`)).toBeLessThanOrEqual(1)
			for (let change of [
				`let p = document.createElement('div'); p.id = 'above-reader'; p.style.height = '180px'; t.prepend(p)`,
				`document.querySelector('#above-reader').style.height = '340px'`,
				`let p = document.createElement('div'); p.style.height = '180px'; t.append(p)`,
			]) {
				await b.evaluate(`(() => { let t = document.querySelector('.Transcript'); ${change} })()`)
				await b.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
				expect(await b.evaluate(`Math.abs(reading.getBoundingClientRect().top - readingTop)`)).toBeLessThanOrEqual(1)
			}
			await b.evaluate(`(async () => {
				let t = document.querySelector('.Transcript');
				t.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
				t.scrollTop = t.scrollHeight - t.clientHeight - 20;
				t.dispatchEvent(new Event('scroll'));
				await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
				window.nearBottomTop = t.scrollTop;
				let p = document.createElement('div'); p.style.height = '200px'; t.append(p);
				await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
			})()`)
			expect(await b.evaluate(`document.querySelector('.Transcript').scrollTop`)).toBe(
				await b.evaluate(`nearBottomTop`),
			)
		} finally {
			release()
			finish()
			await b.close()
		}
	},
	20000,
)
