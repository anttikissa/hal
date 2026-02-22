// Create a unique 4-char alphanumeric dir under /tmp/hal/state/.
// Prints the path to stdout. Used by both `run` (via bun -e) and args.ts.
import { existsSync, mkdirSync } from 'fs'
import { randomBytes } from 'crypto'

const base = '/tmp/hal/state'
const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

export function makeFreshDir(): string {
	mkdirSync(base, { recursive: true })
	for (let i = 0; i < 100; i++) {
		const id = Array.from(randomBytes(4), (b) => chars[b % chars.length]).join('')
		const dir = `${base}/${id}`
		if (!existsSync(dir)) {
			mkdirSync(dir)
			return dir
		}
	}
	throw new Error('could not create unique fresh dir')
}

// When run directly (bun -e or bun src/fresh-dir.ts), print and exit
if (import.meta.main) {
	process.stdout.write(makeFreshDir())
}
