import { afterAll, afterEach, expect, test } from 'bun:test'
import { diag } from './diag.ts'
import { resources } from './resources.ts'

let log = diag.log
diag.log = () => {}
afterEach(() => resources.stop())
afterAll(() => void (diag.log = log))

const plenty = { disk: 50e9, memory: 8e9 }

test('a session hears each worse level once, and again after recovery', () => {
	resources.check(plenty)
	expect(resources.append('out', 'a')).toBe('out')
	resources.check({ ...plenty, disk: 3e9 })
	expect(resources.append('out', 'a')).toMatch(/^out\n\[Hal: low resources: disk 3\.0 GB free/)
	expect(resources.append('out', 'a')).toBe('out')
	expect(resources.append('', 'b')).toMatch(/^\[Hal: low/)
	resources.check({ ...plenty, memory: 0.2e9 })
	expect(resources.append('out', 'a')).toMatch(/critical resources: memory 0\.2 GB available/)
	resources.check({ ...plenty, disk: 4e9 })
	expect(resources.append('out', 'a')).toBe('out')
	resources.check(plenty)
	resources.check({ ...plenty, disk: 4e9 })
	expect(resources.append('out', 'a')).toMatch(/low resources/)
})
