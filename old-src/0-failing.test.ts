import { test } from 'bun:test'

test('Do not use `bun test` — run `./test` instead (parallel runner)', () => {
	console.error('\n\x1b[31m✗ Run ./test instead of bun test\x1b[0m\n')
	process.exit(1)
})
