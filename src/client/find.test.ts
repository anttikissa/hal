import { expect, test } from 'bun:test'
import { keyHelp } from '../common/key-help.ts'
import { app } from './app.ts'
import { appView } from './app-view.ts'
import { find } from './find.ts'
import { frame } from './frame.ts'
import { render } from './render.ts'

test('Ctrl-F debounces transient queries, cancels on Escape and tells where the selected block is', async () => {
	let saved = { send: app.send, show: render.show }, sent: any[] = []
	app.reset(); app.send = (c) => { sent.push(c) }; render.show = () => {}
	try {
		app.state.prompt = { text: 'unsent draft', cursor: 12 }
		app.onKeys([keyHelp.parse('ctrl-f')])
		app.onKeys([{ ...keyHelp.parse('paste'), text: 'needle' }])
		app.onKeys([keyHelp.parse('tab')]) // Focus changes must not drop the pending query.
		await Bun.sleep(120)
		let q = sent.find((c) => c.type === 'find')
		expect(q.query).toBe('needle')
		expect(sent.filter((c) => c.type === 'find')).toHaveLength(1)
		expect(app.state.prompt.text).toBe('unsent draft')
		app.onKeys([keyHelp.parse('escape')])
		expect(app.state.modal).toBeUndefined()
		expect(sent.at(-1).type).toBe('find-cancel')
		app.onEvent({ type: 'snapshot', sessionId: '1-abc', snapshot: { meta: { id: '1-abc', cwd: '/tmp', model: 'example/model', createdAt: '' }, history: [], state: { type: 'idle' } } })
		app.state.transcript!.items = Array.from({ length: 40 }, (_, i) => ({ type: 'prompt' as const, key: String(i + 1), text: i === 8 ? 'needle target block' : `context ${i}` }))
		find.go({ sessionId: '1-abc', blockId: '9' })
		expect(app.state.notice).toMatch(/^Hal can't scroll the terminal: #u9 is about \d+% down the scrollback$/)
		// Nothing is cut: the frame still ends with the newest block.
		expect(frame.build(appView.view(), 80, 24, true).lines.join('\n')).toContain('context 39')
	} finally { app.reset(); app.send = saved.send; render.show = saved.show }
})
