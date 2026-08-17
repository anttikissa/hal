import { expect, test } from 'bun:test'
import { resolve } from 'path'
import { write } from './write.ts'

const REPO_ROOT = resolve(import.meta.dir, '../../..')

test('typechecks TypeScript files inside the Hal repo', () => {
	expect(write.shouldTypecheckEditedPath(resolve(REPO_ROOT, 'src/foo.ts'))).toBe(true)
	expect(write.shouldTypecheckEditedPath(resolve(REPO_ROOT, 'src/foo.tsx'))).toBe(true)
})

test('skips non-TypeScript files', () => {
	expect(write.shouldTypecheckEditedPath(resolve(REPO_ROOT, 'src/foo.js'))).toBe(false)
})

// Hal's tsconfig/oxlintrc do not apply to other projects, so checking their
// files would emit errors the user never asked for.
test('skips TypeScript files outside the Hal repo', () => {
	expect(write.shouldTypecheckEditedPath('/tmp/tetris/tetris.ts')).toBe(false)
	expect(write.shouldTypecheckEditedPath(REPO_ROOT + '-other/foo.ts')).toBe(false)
})
