// Checks that the browser keeps the text being read in place as content
// changes above and below it (task tzg).
import { expect } from 'bun:test'
import type { StreamEvent } from '../common/blocks.ts'
import { tabs } from './tabs.ts'
import { turns } from './turns.ts'
import { server } from './server.ts'
import { web } from './web.ts'
import { useWeb, base, cookieParts, providerHome } from './web-fixture.test.ts'
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
			await b.call('Network.setCookie', { ...(await cookieParts()), url: base() })
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
			release()
			await b.waitFor(`document.querySelector('.Transcript')?.innerText.includes('Finished table.')`)
			await b.evaluate(`(async () => {
				let t = document.querySelector('.Transcript');
				window.reading = [...t.querySelectorAll('td span')].find(e => e.textContent === 'Row 25');
				t.scrollTop += reading.getBoundingClientRect().top - t.getBoundingClientRect().top - t.clientHeight / 2;
				await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
				window.readingTop = reading.getBoundingClientRect().top;
			})()`)
			for (let change of [
				`let p = document.createElement('div'); p.id = 'above-reader'; p.style.height = '180px'; rows.prepend(p)`,
				`document.querySelector('#above-reader').style.height = '340px'`,
				`let p = document.createElement('div'); p.style.height = '180px'; rows.append(p)`,
			]) {
				await b.evaluate(`(() => { let rows = document.querySelector('.Transcript .rows'); ${change} })()`)
				await b.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
				expect(await b.evaluate(`Math.abs(reading.getBoundingClientRect().top - readingTop)`)).toBeLessThanOrEqual(1)
			}
			// 20px above the bottom is above it: growth below leaves the view.
			await b.evaluate(`(async () => {
				let t = document.querySelector('.Transcript');
				t.scrollTop = -20;
				await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
				window.last = [...t.querySelectorAll('.Card')].at(-1);
				window.lastTop = last.getBoundingClientRect().top;
				let p = document.createElement('div'); p.style.height = '200px'; t.querySelector('.rows').append(p);
				await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
			})()`)
			expect(await b.evaluate(`Math.abs(last.getBoundingClientRect().top - lastTop)`)).toBeLessThanOrEqual(1)
		} finally {
			release()
			finish()
			await b.close()
		}
	},
	20000,
)
