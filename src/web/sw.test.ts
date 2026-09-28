import { expect, test } from 'bun:test'

// Execute the actual worker as a worker would, with only the web APIs it uses.
test('a push displays a notification and clicking it focuses its session', async () => {
	let handlers: Record<string, (event: any) => void> = {}
	let shown: any[] = []
	let focused: string[] = []
	let worker = {
		location: { origin: 'https://example.com' },
		addEventListener: (name: string, handler: (event: any) => void) => { handlers[name] = handler },
		registration: { showNotification: async (title: string, opts: any) => { shown.push({ title, opts }) } },
		clients: {
			matchAll: async () => [{ url: 'https://example.com/abc', focus: async () => { focused.push('abc') } }],
			openWindow: async (url: string) => { focused.push(url) },
		},
	}
	new Function('self', await Bun.file(`${import.meta.dir}/sw.js`).text())(worker)
	let pending: Promise<any> = Promise.resolve()
	handlers.push!({ data: { json: () => ({ id: 'abc', title: 'Session', body: 'done' }) }, waitUntil: (promise: Promise<any>) => { pending = promise } })
	await pending
	expect(shown).toHaveLength(1)
	expect(shown[0]!.opts.body).toBe('done')
	let notification = { data: shown[0]!.opts.data, close: () => {} }
	handlers.notificationclick!({ notification, waitUntil: (promise: Promise<any>) => { pending = promise } })
	await pending
	expect(focused).toEqual(['abc'])
	// A payload cannot turn the notification into a cross-origin link.
	handlers.push!({ data: { json: () => ({ id: 'https://evil.example/' }) }, waitUntil: (promise: Promise<any>) => { pending = promise } })
	await pending
	expect(shown[1]!.opts.data.url).toBe('/')
})
