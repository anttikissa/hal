import { test } from 'bun:test'

test('Do not use `bun test` — run `./test` instead (parallel runner)', () => {
	throw new Error('Run ./test instead of bun test')
})
