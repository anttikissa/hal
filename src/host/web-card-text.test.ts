// Browser tests of card contents: EDIT statistics, interrupted answers,
// rebase diffs and Bash status.

import { expect } from 'bun:test'
import { writeFileSync } from 'fs'
import { history } from './history.ts'
import { host } from './host.ts'
import { tabs } from './tabs.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'
import { useWeb, base, cookie, providerHome } from './web-fixture.test.ts'
import { browser, browserTest, useChrome } from './web-chrome-fixture.test.ts'

useWeb()
useChrome()

browserTest(
	'EDIT statistics preserve readable closed titles and full-width open titles',
	async () => {
		let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
		let ts = new Date().toISOString()
		for (let [name, path, marks] of [
			['short', 'a.ts', [29]],
			['long', 'src/host/file-changes.ts', [6, 25, 28, 31, 37, 42, 59, 71, 100, 120]],
		] as const) {
			history.append(id, {
				type: 'assistant',
				block: { type: 'tool_call', id: name, name: 'edit', input: { path } },
				ts,
			})
			history.append(id, {
				type: 'user',
				blocks: [
					{
						type: 'tool_result',
						id: name,
						output: 'Edited',
						diff: marks.map((n) => `-${n} old\n+${n} new`).join('\n'),
					},
				],
				ts,
			})
		}
		history.append(id, { type: 'turn_end', status: 'completed', usage: {}, ts })
		let b = await browser()
		try {
			await server.serve()
			web.start()
			await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
			await b.waitFor(`document.querySelectorAll('.Card.tool .status.diff').length === 2`)
			for (let [width, height] of [
				[320, 760],
				[390, 800],
				[844, 390],
				[1200, 800],
			]) {
				await b.call('Emulation.setDeviceMetricsOverride', {
					width,
					height,
					deviceScaleFactor: 1,
					mobile: width! < 900,
				})
				for (let open of [false, true]) {
					if (open) await b.evaluate(`document.querySelectorAll('.Card.tool .mark').forEach(b => b.click())`)
					await b.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
					let rows = await b.evaluate(
						`Array.from(document.querySelectorAll('.Card.tool'), c => { let h = c.querySelector('.CardHeader'), flow = h.querySelector('.flow').getBoundingClientRect(), status = h.querySelector('.status').getBoundingClientRect(), link = h.querySelector('.link').getBoundingClientRect(), stamp = h.querySelector('.stamp').getBoundingClientRect(); return { flowWidth: flow.width, statusWidth: status.width, separated: status.top >= flow.bottom - 1, linkClear: flow.right <= link.left, stampFits: stamp.right <= flow.right, rowHeight: h.getBoundingClientRect().height, fits: c.scrollWidth <= c.clientWidth, stats: h.querySelector('.status').textContent, title: h.querySelector('.title').textContent }; })`,
					)
					for (let row of rows) {
						expect(row.fits).toBe(true)
						expect(row.stampFits).toBe(true)
						expect(row.linkClear).toBe(true)
						if (open) {
							expect(row.separated).toBe(true)
							expect(row.flowWidth).toBeGreaterThan(width! / 2)
						} else {
							expect(row.flowWidth).toBeGreaterThan(row.statusWidth)
							expect(row.rowHeight).toBe(44)
						}
					}
					expect(rows[1].stats).toContain('120')
				}
				await b.evaluate(`document.querySelectorAll('.Card.tool .mark').forEach(b => b.click())`)
			}
		} finally {
			await b.close()
		}
	},
	15000,
)

browserTest('interrupted answers keep accessible decoration outside prose at phone and desktop widths', async () => {
	providerHome()
	let id = tabs.create('/tmp')
	for (let text of ['short', 'trailing ', 'line\n', '**long** '.repeat(50) + 'ending', '```ts\nconst partial ='])
		history.append(id, { type: 'assistant', block: { type: 'text', text }, interrupted: true })
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Network.setCookie', { name: 'hal', value: (await cookie()).slice(4), url: base() })
		await b.call('Page.navigate', { url: `${base()}/${id}` })
		await b.waitFor(`document.querySelectorAll('.interrupted').length === 5`)
		for (let width of [390, 1280]) {
			await b.call('Emulation.setDeviceMetricsOverride', {
				width,
				height: 800,
				deviceScaleFactor: 1,
				mobile: width === 390,
			})
			let marks = await b.evaluate(
				`Array.from(document.querySelectorAll('.interrupted'), el => ({ tail: el.dataset.tail, label: el.getAttribute('aria-label'), prose: el.textContent, contrasting: getComputedStyle(el).color !== getComputedStyle(el.parentElement).color, visible: el.getBoundingClientRect().width > 0, fits: el.getBoundingClientRect().right <= innerWidth }))`,
			)
			expect(await b.evaluate(`!!document.querySelector('pre code .interrupted')`)).toBe(true)
			expect(marks).toEqual(
				[' --', ' --', '\n--', ' --', ' --'].map((tail) => ({
					tail,
					label: 'Interrupted',
					prose: '',
					contrasting: true,
					visible: true,
					fits: true,
				})),
			)
		}
	} finally {
		await b.close()
	}
})

browserTest('rebase diffs are visible and colored after an earlier error and help opens full output', async () => {
	let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id,
		b = await browser()
	let report =
		'Rebase applied (dropped 11 entries, edited 1)\nDropped 11 entries: #170-180 (11 entries)\n--paused\nEdited #169 prompt:\n```diff\n-old\n+replacement\n```'
	history.append(id, { type: 'output', text: 'Rebase failed: editor exited with code 1', error: true })
	history.append(id, { type: 'output', text: report })
	history.append(id, {
		type: 'user',
		blocks: [{ type: 'text', text: 'A conversation message separates these cards.' }],
	})
	history.append(id, {
		type: 'assistant',
		block: { type: 'tool_call', id: 'help', name: 'command', input: { command: '/help rebase' } },
	})
	history.append(id, {
		type: 'user',
		blocks: [
			{ type: 'tool_result', id: 'help', output: Array.from({ length: 240 }, (_, n) => `help line ${n}`).join('\n') },
		],
	})
	history.append(id, { type: 'turn_end', status: 'completed', usage: {} })
	try {
		await server.serve()
		web.start()
		await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
		await b.waitFor(
			`!!document.querySelector('pre[data-lang=diff] .add') && !!document.querySelector('.tool-command .mark')`,
		)
		for (let width of [390, 1280]) {
			await b.call('Emulation.setDeviceMetricsOverride', {
				width,
				height: 800,
				deviceScaleFactor: 1,
				mobile: width === 390,
			})
			let result = await b.evaluate(`(() => {
				let code = document.querySelector('pre[data-lang=diff]'), card = code.closest('.Card');
				return { text: card.textContent, error: card.classList.contains('error'),
					colors: ['del', 'add'].map(c => getComputedStyle(code.querySelector('.' + c)).color),
					visible: code.getBoundingClientRect().height > 0,
					errorSeparate: [...document.querySelectorAll('.Card.error')].some(el => el.textContent.includes('editor exited with code 1')) };
			})()`)
			expect(result.text).toContain('Dropped 11 entries: #170-180 (11 entries)')
			expect(result.text).toContain('--paused')
			expect(result.text).toContain('+replacement')
			expect(result.text).not.toContain('```')
			expect(result.error).toBe(false)
			expect(result.visible).toBe(true)
			expect(result.errorSeparate).toBe(true)
			expect(result.colors[0]).not.toBe(result.colors[1])
			expect(await b.evaluate(`document.querySelector('.tool-command .label').textContent`)).toBe('/help rebase')
			await b.evaluate(`document.querySelector('.tool-command .mark').click()`)
			await b.waitFor(`document.querySelector('.tool-command .mark').getAttribute('aria-expanded') === 'true'`)
			expect(await b.evaluate(`document.querySelector('.tool-command .result-text').textContent`)).toContain(
				'help line 239',
			)
			expect(await b.evaluate(`document.querySelector('.tool-command .more') === null`)).toBe(true)
			await b.evaluate(`document.querySelector('.tool-command .mark').click()`)
			expect(await b.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true)
		}
	} finally {
		await b.close()
	}
})

browserTest('foreground and background Bash share header status without losing output or command links', async () => {
	let id = sessions.create({ cwd: '/tmp', model: 'example/model' }).id
	history.append(id, {
		type: 'assistant',
		block: {
			type: 'tool_call',
			id: 'run',
			name: 'bash',
			input: { description: 'Check output', command: 'printf example' },
		},
	})
	history.append(id, {
		type: 'user',
		blocks: [{ type: 'tool_result', id: 'run', output: '[exit 1]\nForeground output', ms: 2700 }],
	})
	history.append(id, {
		type: 'user',
		blocks: [{ type: 'text', from: id, label: 'bash #t1', text: '[exit 1]\nBackground output' }],
	})
	let b = await browser()
	try {
		await server.serve()
		web.start()
		await b.call('Page.navigate', { url: `${base()}/${id}?auth=${webAuth.issue()}` })
		await b.waitFor(`document.querySelectorAll('.CardHeader .exit').length === 2`)
		for (let width of [320, 1200]) {
			await b.call('Emulation.setDeviceMetricsOverride', {
				width,
				height: 800,
				deviceScaleFactor: 1,
				mobile: width === 320,
			})
			let headers = await b.evaluate(
				`Array.from(document.querySelectorAll('.Card > .CardHeader'), h => ({ status: h.querySelector(':scope > .status:not(.line-count)').textContent, beforeLink: h.querySelector(':scope > .status ~ .link') !== null, fits: h.closest('.Card').scrollWidth <= h.closest('.Card').clientWidth, exit: h.querySelector('.exit').textContent }))`,
			)
			expect(headers.map((h: any) => h.status)).toEqual(['(exit 1, 2.7s)', '(exit 1)'])
			expect(headers.every((h: any) => h.beforeLink && h.fits && h.exit === 'exit 1')).toBe(true)
		}
		await b.evaluate(`document.querySelector('.Card.tool .mark').click()`)
		expect(await b.evaluate(`document.querySelector('main').textContent`)).not.toContain('[exit 1]')
		expect(await b.evaluate(`document.querySelector('.result-text').textContent`)).toContain('Foreground output')
		expect(await b.evaluate(`document.querySelector('.Card.background-result .content').textContent`)).toBe(
			'Background output',
		)
		expect(await b.evaluate(`document.querySelector('.Card.background-result .call').getAttribute('href')`)).toEndWith(
			'#t1',
		)
		expect(await b.evaluate(`document.querySelector('.Card.background-result .label').textContent`)).toBe(
			'$ printf example',
		)
		expect(
			await b.evaluate(
				`getComputedStyle(document.querySelector('.Card.background-result')).backgroundColor === getComputedStyle(document.querySelector('.Card.tool')).backgroundColor`,
			),
		).toBe(true)
		await b.evaluate(
			`Promise.all(document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished))`,
		)
		let screenshot = await b.call('Page.captureScreenshot', { format: 'png' })
		writeFileSync('/tmp/hal-shared-bash-header.png', Buffer.from(screenshot.result.data, 'base64'))
	} finally {
		await b.close()
	}
})
