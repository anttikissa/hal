// Installed Home Screen app push handler. Apple revokes permission for silent pushes.
self.addEventListener('push', (event) => {
	let data = {}
	try { data = event.data?.json() ?? {} } catch {}
	let id = typeof data.id === 'string' && /^[\w-]+$/.test(data.id) ? data.id : ''
	let title = typeof data.title === 'string' ? data.title : 'Hal'
	let body = typeof data.body === 'string' ? data.body : 'Needs attention'
	event.waitUntil(self.registration.showNotification(title, { body, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: id ? `/${id}` : '/' } }))
})

self.addEventListener('notificationclick', (event) => {
	event.notification.close()
	let target = new URL(event.notification.data?.url || '/', self.location.origin).href
	event.waitUntil((async () => {
		let windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
		let existing = windows.find((client) => client.url === target)
		if (existing) return existing.focus()
		return self.clients.openWindow(target)
	})())
})
