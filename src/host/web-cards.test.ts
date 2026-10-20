// Browser tests of card chrome: headers, sticky titles, change
// disclosure and queued cards.

import { expect } from 'bun:test'
import { writeFileSync } from 'fs'
import { history } from './history.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'
import { useWeb, base } from './web-fixture.test.ts'
import { browser, browserTest, useChrome } from './web-chrome-fixture.test.ts'

useWeb()
useChrome()

browserTest(
	'card headers restore short or open and expanded tools show whole commands and output',
	async () => {
		let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
		let lines = Array.from({ length: 12 }, (_, i) => `row ${i + 1}`).join('\n')
		history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'Run the checks' }] })
		history.append(id, { type: 'assistant', block: { type: 'thinking', text: `First thought\n${lines}` } })
		history.append(id, {
			type: 'assistant',
			block: {
				type: 'tool_call',
				id: 'ok',
				name: 'bash',
				input: { description: 'Count rows', command: 'seq 12\necho done' },
			},
		})
		history.append(id, {
			type: 'user',
			blocks: [{ type: 'tool_result', id: 'ok', output: `[exit 0]\n${lines}`, ms: 1200 }],
		})
		history.append(id, {
			type: 'assistant',
			block: {
				type: 'tool_call',
				id: 'bad',
				name: 'bash',
				input: { description: 'Read missing', command: 'cat nope' },
			},
		})
		history.append(id, {
			type: 'user',
			blocks: [{ type: 'tool_result', id: 'bad', output: '[exit 1]\ncat: nope: No such file', ms: 1100 }],
		})
		history.append(id, {
			type: 'assistant',
			block: {
				type: 'tool_call',
				id: 'wide',
				name: 'bash',
				input: { description: 'Wide command', command: `printf '${'x'.repeat(70)}'` },
			},
		})
		history.append(id, { type: 'user', blocks: [{ type: 'tool_result', id: 'wide', output: '[exit 0]\nok' }] })
		history.append(id, { type: 'assistant', block: { type: 'text', text: 'All done.' } })
		history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Emulation.setDeviceMetricsOverride', {
				width: 900,
				height: 900,
				deviceScaleFactor: 1,
				mobile: false,
			})
			await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
			await b.waitFor(`document.querySelectorAll('.Card.tool').length === 3`)
			let state = `Array.from(document.querySelectorAll('.Card.thinking, .Card.tool, .Card.assistant'), c => c.classList.contains('open') || !c.classList.contains('folds') ? 'open' : 'short')`
			expect(await b.evaluate(state)).toEqual(['short', 'short', 'short', 'short', 'open'])
			expect(
				await b.evaluate(
					`Array.from(document.querySelectorAll('.Card.thinking .spinner, .Card.tool .spinner, .Card.assistant .spinner')).length`,
				),
			).toBe(5)
			let shot = async (name: string) => {
				await b.evaluate(
					`Promise.all(document.getAnimations().filter(a => a.timeline === document.timeline && a.effect.getTiming().iterations !== Infinity).map(a => a.finished))`,
				)
				writeFileSync(
					`/tmp/hal-172-ink-disclosure-${name}.png`,
					Buffer.from((await b.call('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'),
				)
			}
			let rotate = async (selector: string) => {
				await b.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
				await b.evaluate(
					`Promise.all(document.getAnimations().filter(a => a.timeline === document.timeline && a.effect.getTiming().iterations !== Infinity).map(a => a.finished))`,
				)
			}
			await shot('start')
			await rotate('.Card.user .mark')
			await rotate('.Card.user .mark')
			await rotate('.Card.assistant .mark')
			await rotate('.Card.assistant .mark')
			let steps: string[] = []
			for (let i = 0; i < 2; i++) {
				await rotate('.Card.thinking .mark')
				steps.push((await b.evaluate(state))[0])
				if (i === 0) await shot('thinking-long')
			}
			expect(steps).toEqual(['open', 'short'])
			await rotate('.Card.tool .mark')
			expect(await b.evaluate(`document.querySelector('.Card.tool .ToolCommand .command').textContent`)).toBe(
				'seq 12\necho done',
			)
			expect(await b.evaluate(`document.querySelector('.Card.tool .result-text').textContent`)).toContain('row 12')
			await b.evaluate(`document.querySelector('.Card.tool .result-text').click()`)
			expect(await b.evaluate(`document.querySelector('.Card.tool .mark').getAttribute('aria-expanded')`)).toBe('true')
			await b.evaluate(`document.querySelectorAll('.Card.tool')[2].querySelector('.mark').click()`)
			for (let width of [390, 900]) {
				await b.call('Emulation.setDeviceMetricsOverride', {
					width,
					height: 844,
					deviceScaleFactor: 1,
					mobile: width === 390,
				})
				expect(
					await b.evaluate(`document.querySelectorAll('.Card.tool')[2].querySelector('.command').textContent`),
				).toContain('x'.repeat(70))
				expect(await b.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
			}
			await b.evaluate(
				`(() => { let t = document.querySelector('textarea'); t.value = '/collapse a*'; t.dispatchEvent(new InputEvent('input', { bubbles: true })); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`,
			)
			await b.waitFor(`document.querySelector('.Card.assistant .mark').getAttribute('aria-expanded') === 'false'`)
			await b.evaluate(`document.querySelector('.Card.assistant .mark').click()`)
			expect(await b.evaluate(`document.querySelector('.Card.assistant .mark').getAttribute('aria-expanded')`)).toBe(
				'true',
			)
			await b.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
			await b.evaluate(`document.querySelector('.Card.thinking .mark').click()`)
			expect(await b.evaluate(`document.querySelector('.Card.thinking .mark').getAttribute('aria-expanded')`)).toBe(
				'true',
			)
		} finally {
			await b.close()
		}
	},
	15000,
)

browserTest(
	'all card kinds share aligned triangle-free sticky chrome',
	async () => {
		let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
		let text = Array.from({ length: 40 }, (_, i) => `Content row ${i}`).join('\n')
		history.append(id, { type: 'compact', summary: 'Boundary', prompts: 0 })
		history.append(id, { type: 'user', blocks: [{ type: 'text', text }] })
		history.append(id, { type: 'assistant', block: { type: 'thinking', text } })
		history.append(id, { type: 'assistant', block: { type: 'text', text } })
		history.append(id, {
			type: 'assistant',
			block: {
				type: 'tool_call',
				id: 'chrome',
				name: 'bash',
				input: { command: 'echo first\necho second', description: 'Check chrome' },
			},
		})
		history.append(id, { type: 'user', blocks: [{ type: 'tool_result', id: 'chrome', output: text }] })
		history.append(id, {
			type: 'user',
			blocks: [{ type: 'text', from: id, label: 'bash #t5', text: `[exit 0]\n${text}` }],
		})
		history.append(id, {
			type: 'output',
			text: 'Changed',
			change: {
				name: 'AGENTS.md',
				what: 'changed',
				diff: text
					.split('\n')
					.map((l) => `+${l}`)
					.join('\n'),
			},
		})
		history.append(id, { type: 'command', text: '/example' })
		history.append(id, { type: 'output', text })
		history.append(id, {
			type: 'question',
			id: 'answered',
			form: { text: 'Answered question', fields: [{ type: 'text', name: 'answer' }] },
			from: { command: 'example', args: '' },
		})
		history.append(id, { type: 'answer', question: 'answered', answers: { answer: 'Yes' } })
		history.append(id, { type: 'turn_end', status: 'paused', usage: {} })
		history.append(id, {
			type: 'question',
			id: 'active',
			form: { text: 'Active question', quote: { text }, fields: [{ type: 'text', name: 'answer' }] },
			from: { command: 'example', args: '' },
		})
		history.append(id, { type: 'inbox', id: 'queued', from: 'reviewer', text, delivery: 'after-turn' })
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
			await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
			await b.waitFor(`!!document.querySelector('.Question') && !!document.querySelector('.Card.queued')`)
			for (let width of [390, 1200]) {
				await b.call('Emulation.setDeviceMetricsOverride', {
					width,
					height: 800,
					deviceScaleFactor: 1,
					mobile: width === 390,
				})
				for (let open of [false, true]) {
					await b.evaluate(
						`document.querySelectorAll('.Card > .CardHeader .stamp.mark[aria-expanded="${!open}"]').forEach(b => b.click())`,
					)
					await b.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
					let geometry = await b.evaluate(
						`Array.from(document.querySelectorAll('.Transcript > .Card, .Transcript > .Question'), c => { let h = c.querySelector('.CardHeader'), stamp = h.querySelector('.stamp'); return { headers:c.querySelectorAll('.CardHeader').length, x:stamp.getBoundingClientRect().left, triangle:/[▸▾▶▼]/.test(h.textContent), overflow:c.scrollWidth > c.clientWidth, sticky:getComputedStyle(h.classList.contains('inline') ? stamp : h).position === 'sticky', tall:c.matches('.tall, .Question') }; })`,
					)
					expect(geometry.length).toBeGreaterThanOrEqual(10)
					expect(geometry.every((c: any) => c.headers === 1 && !c.triangle && !c.overflow && c.sticky === c.tall)).toBe(
						true,
					)
					expect(
						Math.max(...geometry.map((c: any) => c.x)) - Math.min(...geometry.map((c: any) => c.x)),
					).toBeLessThanOrEqual(1)
				}
				await b.evaluate(`document.querySelector('.Transcript').dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }))`)
				let sticking = await b.evaluate(
					`(async () => { let main = document.querySelector('.Transcript'), cards = [...main.querySelectorAll(':scope > .Card, :scope > .Question')].filter(c => c.clientHeight > 200), results = []; for (let c of cards) { main.scrollTop += c.getBoundingClientRect().top - main.getBoundingClientRect().top + 60; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); let h = c.querySelector('.CardHeader'), pin = h.classList.contains('inline') ? h.querySelector('.stamp') : h; results.push(Math.abs(pin.getBoundingClientRect().top - main.getBoundingClientRect().top - parseFloat(getComputedStyle(main).paddingTop)) <= 1); } return results; })()`,
				)
				expect(sticking.length).toBeGreaterThanOrEqual(5)
				expect(sticking.every(Boolean)).toBe(true)
			}
		} finally {
			await b.close()
		}
	},
	15000,
)

browserTest(
	'change-card disclosure restores complete vertically unclipped diffs (task r7m)',
	async () => {
		let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
		for (let i = 0; i < 3; i++)
			history.append(id, {
				type: 'output',
				text: 'Instructions changed',
				change: {
					name: 'AGENTS.md',
					what: 'changed',
					diff: Array.from({ length: 12 }, (_, n) => `+change ${i} line ${n}`).join('\n'),
				},
			})
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Emulation.setDeviceMetricsOverride', {
				width: 390,
				height: 844,
				deviceScaleFactor: 1,
				mobile: true,
			})
			await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
			await b.waitFor(`!!document.querySelector('.Card.output .mark')`)
			for (let i = 0; i < 2; i++) {
				await b.evaluate(`document.querySelector('.Card.output .mark').click()`)
				await b.waitFor(`document.querySelectorAll('.change .lines').length === 3`)
				expect(
					await b.evaluate(
						`(() => { let c = document.querySelector('.Card.output'); return { expanded: c.querySelector('.mark').getAttribute('aria-expanded'), rows: c.querySelectorAll('.lines > div').length, unclipped: c.scrollHeight <= c.clientHeight } })()`,
					),
				).toEqual({ expanded: 'true', rows: 36, unclipped: true })
				await b.evaluate(`document.querySelector('.change .lines').click()`)
				expect(await b.evaluate(`document.querySelectorAll('.change .lines').length`)).toBe(3)
				await b.evaluate(`document.querySelector('.Card.output .mark').click()`)
				await b.waitFor(`document.querySelectorAll('.change .lines').length === 0`)
				expect(await b.evaluate(`document.querySelector('.Card.output .mark').getAttribute('aria-expanded')`)).toBe(
					'false',
				)
			}
		} finally {
			await b.close()
		}
	},
	15000,
)

browserTest(
	'queued cards share block controls and keep sender backgrounds when expanded',
	async () => {
		let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
		let queued = history.append(id, {
			type: 'inbox',
			id: 'agent-queue',
			from: 'reviewer',
			text: '**First line**\n\nLast line of the complete message',
			delivery: 'after-turn',
		})
		history.append(id, { type: 'inbox', id: 'human-queue', text: 'Human queue', delivery: 'after-turn' })
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
			await b.waitFor(`document.querySelectorAll('.Card.queued').length === 2`)
			let command = async (text: string) => {
				await b.evaluate(
					`(() => { let t = document.querySelector('textarea'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`,
				)
				await b.evaluate(`document.querySelector('.Composer .go').click()`)
			}
			for (let width of [390, 1200]) {
				await b.call('Emulation.setDeviceMetricsOverride', {
					width,
					height: 800,
					deviceScaleFactor: 1,
					mobile: width === 390,
				})
				expect(
					await b.evaluate(`document.querySelector('.Card.queued.message').textContent.includes('Last line')`),
				).toBe(false)
				await command(`/expand #m${queued.n}`)
				await b.waitFor(`document.querySelector('.Card.queued.message').textContent.includes('Last line')`)
				let shown = await b.evaluate(
					`(() => { let agent = document.querySelector('.Card.queued.message'), human = document.querySelector('.Card.queued.user'), body = agent.querySelector('.content'); return { agent: getComputedStyle(agent).backgroundColor, human: getComputedStyle(human).backgroundColor, body: getComputedStyle(body).backgroundColor, margin: parseFloat(getComputedStyle(agent).marginBottom), overflow: document.documentElement.scrollWidth > innerWidth + 1, receipt: !!agent.querySelector('.receipt') }; })()`,
				)
				expect(shown.agent).not.toBe(shown.human)
				expect(['rgba(0, 0, 0, 0)', shown.agent]).toContain(shown.body)
				expect(shown.margin).toBeGreaterThan(0)
				expect(shown.overflow).toBe(false)
				expect(shown.receipt).toBe(true)
				await command(`/collapse #m${queued.n}`)
				await b.waitFor(`!document.querySelector('.Card.queued.message').textContent.includes('Last line')`)
				await b.evaluate(`document.querySelector('.Card.queued.message').click()`)
				await b.waitFor(`document.querySelector('.Card.queued.message').textContent.includes('Last line')`)
				await command(`/toggle #m${queued.n}`)
				await b.waitFor(`!document.querySelector('.Card.queued.message').textContent.includes('Last line')`)
			}
		} finally {
			await b.close()
		}
	},
	10000,
)
