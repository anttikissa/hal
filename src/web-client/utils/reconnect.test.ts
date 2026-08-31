import { expect, test } from 'bun:test'
import { reconnect } from './reconnect.ts'

test('keeps retrying until the web server is reachable', async () => {
	let attempts = 0
	let pauses = 0

	await reconnect.waitForServer(
		async () => ++attempts === 3,
		async () => {
			pauses++
		},
	)

	expect(attempts).toBe(3)
	expect(pauses).toBe(2)
})

test('stops retrying when its app is disposed', async () => {
	let stopped = false
	let attempts = 0

	const reached = await reconnect.waitForServer(
		async () => {
			attempts++
			return false
		},
		async () => {
			stopped = true
		},
		() => stopped,
	)

	expect(reached).toBe(false)
	expect(attempts).toBe(1)
})
