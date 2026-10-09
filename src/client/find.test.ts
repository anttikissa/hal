import { expect, test } from 'bun:test'
import { keyHelp } from '../common/key-help.ts'
import { app } from './app.ts'
import { find } from './find.ts'
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
	} finally { app.reset(); app.send = saved.send; render.show = saved.show }
})
