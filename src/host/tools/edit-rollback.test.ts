// EDIT tests for failures mid-write: rollback, recovery copies and
// target identity checks.
import '../host.ts'
import { expect, test, spyOn } from 'bun:test'
import {
	readFileSync,
	writeFileSync,
	existsSync,
	symlinkSync,
	readdirSync,
	unlinkSync,
	chmodSync,
	statSync,
	realpathSync,
} from 'fs'
import { io } from './edit.ts'
import { file, run } from './edit-fixture.test.ts'
import { fileChanges } from '../file-changes.ts'
import { fileText } from '../file-text.ts'
import { testHome, useHost } from '../host-fixture.test.ts'
import { paths } from '../paths.ts'

useHost()

test('symlink retargeting cannot overwrite another file with identical bytes', async () => {
	const a = file('a', 'same'),
		b = file('b', 'same'),
		original = io.save
	const mock = spyOn(io, 'save').mockImplementation(async (...args) => {
		unlinkSync(a)
		symlinkSync(b, a)
		await original(...args)
	})
	try {
		await expect(run([{ path: 'a', old: 'same', new: 'changed' }])).rejects.toThrow('target identity changed')
		expect(readFileSync(b, 'utf8')).toBe('same')
	} finally {
		mock.mockRestore()
	}
})

test('cancellation after a write rolls the entire change back', async () => {
	const a = file('a', 'old'),
		b = file('b', 'before'),
		controller = new AbortController(),
		original = io.save
	let calls = 0
	const mock = spyOn(io, 'save').mockImplementation(async (...args) => {
		await original(...args)
		if (++calls === 1) controller.abort()
	})
	try {
		await expect(
			run(
				[
					{ path: 'a', old: 'old', new: 'new' },
					{ path: 'b', old: 'before', new: 'after' },
				],
				controller.signal,
			),
		).rejects.toThrow('Rolled back all writes')
		expect(readFileSync(a, 'utf8')).toBe('old')
		expect(readFileSync(b, 'utf8')).toBe('before')
	} finally {
		mock.mockRestore()
	}
})

test('cleanup failure preserves the original failure', async () => {
	file('a', 'same')
	const original = fileChanges.finish
	const mock = spyOn(fileChanges, 'finish').mockImplementation(async (...args) => {
		await original(...args)
		throw new Error('finish failure')
	})
	try {
		const result = run([{ path: 'a', old: 'missing', new: 'x' }])
		await expect(result).rejects.toThrow('old not found')
		await expect(result).rejects.toThrow('finish failure')
	} finally {
		mock.mockRestore()
	}
})

for (const external of [false, true])
	test(`write failure rolls back; external conflict=${external}`, async () => {
		const a = file('a', 'old'),
			b = file('b', 'before'),
			original = io.save
		let calls = 0
		const mock = spyOn(io, 'save').mockImplementation(async (...args) => {
			if (++calls === 3) {
				if (external) writeFileSync(a, 'external')
				throw new Error('injected failure')
			}
			await original(...args)
		})
		try {
			await expect(
				run([
					{ path: 'new', new: 'created' },
					{ path: 'a', old: 'old', new: 'changed' },
					{ path: 'b', old: 'before', new: 'after' },
				]),
			).rejects.toThrow(external ? 'Recovery copies:' : 'Rolled back all writes')
			expect(readFileSync(a, 'utf8')).toBe(external ? 'external' : 'old')
			expect(readFileSync(b, 'utf8')).toBe('before')
			expect(existsSync(`${testHome()}/new`)).toBe(false)
			if (external) {
				const dir = readdirSync(paths.tmpDir()).find((p) => p.startsWith('multiedit-'))!
				expect(readFileSync(`${paths.tmpDir()}/${dir}/1`, 'utf8')).toBe('old')
			}
		} finally {
			mock.mockRestore()
		}
	})

for (const external of [false, true])
	test(`failed batch restores deleted file and permissions; external replacement=${external}`, async () => {
		const a = file('a', 'original'),
			b = file('b', 'before'),
			original = io.save
		chmodSync(a, 0o751)
		const mock = spyOn(io, 'save').mockImplementation(async (...args) => {
			if (args[0] === realpathSync(b)) {
				if (external) writeFileSync(a, 'external')
				throw new Error('injected failure')
			}
			await original(...args)
		})
		try {
			await expect(
				run([
					{ path: 'a', hash: fileText.hash(readFileSync(a)), delete: true },
					{ path: 'b', old: 'before', new: 'after' },
				]),
			).rejects.toThrow(external ? 'Recovery copies:' : 'Rolled back all writes')
			expect(readFileSync(a, 'utf8')).toBe(external ? 'external' : 'original')
			expect(readFileSync(b, 'utf8')).toBe('before')
			if (!external) expect(statSync(a).mode & 0o7777).toBe(0o751)
			else {
				const dir = readdirSync(paths.tmpDir()).find((p) => p.startsWith('multiedit-'))!
				expect(readFileSync(`${paths.tmpDir()}/${dir}/0`, 'utf8')).toBe('original')
			}
		} finally {
			mock.mockRestore()
		}
	})

test('cancellation after deletion restores the file; a changed target is never deleted', async () => {
	const a = file('a', 'original'),
		b = file('b', 'original'),
		original = io.save,
		controller = new AbortController()
	let mock = spyOn(io, 'save').mockImplementation(async (...args) => {
		await original(...args)
		controller.abort()
	})
	try {
		await expect(
			run([{ path: 'a', hash: fileText.hash(readFileSync(a)), delete: true }], controller.signal),
		).rejects.toThrow('Rolled back all writes')
		expect(readFileSync(a, 'utf8')).toBe('original')
	} finally {
		mock.mockRestore()
	}
	mock = spyOn(io, 'save').mockImplementation(async (...args) => {
		writeFileSync(a, 'external')
		await original(...args)
	})
	try {
		await expect(run([{ path: 'a', delete: true }])).rejects.toThrow('changed outside Hal')
		expect(readFileSync(a, 'utf8')).toBe('external')
	} finally {
		mock.mockRestore()
	}
	mock = spyOn(io, 'save').mockImplementation(async (...args) => {
		unlinkSync(a)
		symlinkSync(b, a)
		await original(...args)
	})
	try {
		await expect(run([{ path: 'a', hash: fileText.hash(readFileSync(a)), delete: true }])).rejects.toThrow(
			'target identity changed',
		)
		expect(readFileSync(b, 'utf8')).toBe('original')
	} finally {
		mock.mockRestore()
	}
})
