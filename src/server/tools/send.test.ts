import { afterEach, expect, test } from 'bun:test'
import { ipc } from '../../ipc.ts'
import { inbox } from '../runtime/inbox.ts'
import { send } from './send.ts'

const origQueueMessage = inbox.queueMessage
const origReadState = ipc.readState

afterEach(() => {
	inbox.queueMessage = origQueueMessage
	ipc.readState = origReadState
})

test('send result includes target tab when the session is open', async () => {
	const queued: any[] = []
	inbox.queueMessage = (sessionId, text, from, queue) => {
		queued.push({ sessionId, text, from, queue })
	}
	ipc.readState = () => ({
		sessions: [
			{ id: '04-parent', tab: 1, cwd: '/tmp/parent' },
			{ id: '04-target', tab: 3, cwd: '/tmp/target' },
		],
		working: {},
		updatedAt: new Date().toISOString(),
	})

	const result = await send.execute({ sessionId: '04-target', text: 'hello' }, { sessionId: '04-parent', cwd: '/tmp/parent' })

		expect(result).toBe('Message sent to tab 3 · 04-target')
		expect(queued).toEqual([{ sessionId: '04-target', text: 'hello', from: '04-parent', queue: false }])
	})

	test('send result says queued when deferred delivery was requested', async () => {
		inbox.queueMessage = () => {}
		ipc.readState = () => ({ sessions: [], working: {}, updatedAt: new Date().toISOString() })

		const result = await send.execute({ sessionId: '04-target', text: 'hello', queue: true }, { sessionId: '04-parent', cwd: '/tmp/parent' })

		expect(result).toBe('Message queued for 04-target')
})
