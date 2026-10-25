// Active question controls stay reachable while their history scrolls away.
import { expect } from 'bun:test'
import { history } from './history.ts'
import { host } from './host.ts'
import { snapshots } from './snapshots.ts'
import { tabs } from './tabs.ts'
import { server } from './server.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'
import { useWeb, base, providerHome } from './web-fixture.test.ts'
import { browser, browserTest, useChrome } from './web-chrome-fixture.test.ts'

useWeb()
useChrome()

browserTest('a trust question stays visible through later output and history scrolling', async () => {
	providerHome()
	let id = tabs.create('/tmp')
	history.append(id, {
		type: 'question',
		id: 'trust',
		form: {
			text: 'Trust this project? Its instructions, skills, and plugins can direct Hal and run code with your permissions.\n/example/project',
			fields: [
				{ type: 'choice', name: 'trust', options: ['Trust project', 'Continue without project content'], initial: 1 },
			],
		},
		from: { command: 'cd', args: '/example/project' },
	})
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
		await b.waitFor(`!!document.querySelector('.Question')`)
		await b.evaluate(`window.keptQuestion = document.querySelector('.Question')`)
		history.append(id, { type: 'output', text: 'Later output\n'.repeat(100) })
		host.broadcast(id, { type: 'snapshot', sessionId: id, snapshot: snapshots.build(id) })
		await b.waitFor(`document.querySelector('.Transcript')?.innerText.includes('Later output')`)
		for (let width of [1280, 390]) {
			await b.call('Emulation.setDeviceMetricsOverride', {
				width,
				height: 800,
				deviceScaleFactor: 1,
				mobile: width === 390,
			})
			for (let position of [0, 1e6]) {
				await b.evaluate(`document.querySelector('.Transcript').scrollTop = ${position}`)
				await b.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
				expect(
					await b.evaluate(`(() => {
					let q = document.querySelector('.Question'), r = q.getBoundingClientRect();
					let composer = document.querySelector('.Composer').getBoundingClientRect();
					return q === window.keptQuestion && r.top >= 0 && r.bottom <= composer.top &&
						[...q.querySelectorAll('button')].every(b => { let x = b.getBoundingClientRect(); return x.top >= r.top && x.bottom <= r.bottom; });
				})()`),
				).toBe(true)
			}
		}
		expect(await b.evaluate(`document.querySelector('.Question [aria-pressed="true"]').textContent`)).toBe(
			'Continue without project content',
		)
		await b.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' })
		await b.waitFor(`!document.querySelector('.Question')`)
		expect(history.readSync(id).some((r) => r.type === 'answer' && r.question === 'trust' && r.canceled)).toBe(true)
		expect(await b.evaluate(`document.querySelector('.Card.question').textContent`)).toContain('canceled')
		await b.evaluate(`document.querySelector('.Composer textarea').focus()`)
		await b.call('Input.insertText', { text: 'Keyboard works' })
		expect(await b.evaluate(`document.querySelector('.Composer textarea').value`)).toBe('Keyboard works')
	} finally {
		await b.close()
	}
})
