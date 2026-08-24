const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'

function make(used = new Set<string>()): string {
	for (;;) {
		const bytes = crypto.getRandomValues(new Uint8Array(3))
		let tail = ''
		for (const byte of bytes) tail += alphabet[byte % alphabet.length]
		const id = `${Math.max(0, Date.now()).toString(36).slice(-6).padStart(6, '0')}-${tail}`
		if (!used.has(id)) return id
	}
}

function isValid(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z0-9]{6}-[a-z0-9]{3}$/.test(value)
}

export const historyIds = { make, isValid }
