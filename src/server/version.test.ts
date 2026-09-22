import { afterEach, expect, test } from 'bun:test'
import { version } from './version.ts'

const origReadHead = version.io.readHead
const origHasDirty = version.io.hasDirty
const origReadDirtyTreeHash = version.io.readDirtyTreeHash

afterEach(() => {
	version.io.readHead = origReadHead
	version.io.hasDirty = origHasDirty
	version.io.readDirtyTreeHash = origReadDirtyTreeHash
	version.resetForTests()
})

test('refresh appends a dirty tree hash when local edits exist', async () => {
	version.io.readHead = async () => 'abcd1234'
	version.io.hasDirty = async () => true
	version.io.readDirtyTreeHash = async () => 'xyzw2345cafebabe'

	await version.refresh('/tmp/hal-test-dirty')

	expect(version.state).toMatchObject({
		status: 'ready',
		head: 'abcd1234',
		dirtyHash: 'xyzw2345',
		combined: 'abcd1234+xyzw2345',
	})
})
