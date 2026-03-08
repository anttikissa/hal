import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { initBus, claimOwner, releaseOwner, verifyOwnership, ensureBus } from '../ipc.ts'

let dir: string

beforeEach(async () => {
	dir = mkdtempSync(resolve(tmpdir(), 'hal-ipc-test-'))
	initBus(dir)
	await ensureBus()
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

describe('claimOwner', () => {
	test('first caller becomes owner', async () => {
		const result = await claimOwner('a')
		expect(result.owner).toBe(true)
		expect(result.currentOwnerPid).toBe(process.pid)
	})

	test('second caller with different ownerId is rejected', async () => {
		await claimOwner('a')
		const result = await claimOwner('b')
		expect(result.owner).toBe(false)
		expect(result.currentOwnerPid).toBe(process.pid)
	})

	test('calling claimOwner again with same ownerId recognizes own lock', async () => {
		await claimOwner('a')
		const result = await claimOwner('a')
		expect(result.owner).toBe(true)
		expect(result.currentOwnerPid).toBe(process.pid)
	})

	test('after release, new caller can claim', async () => {
		await claimOwner('a')
		await releaseOwner('a')
		const result = await claimOwner('b')
		expect(result.owner).toBe(true)
	})

	test('release by wrong ownerId is a no-op', async () => {
		await claimOwner('a')
		await releaseOwner('wrong')
		// Lock file should still exist
		expect(existsSync(`${dir}/owner.lock`)).toBe(true)
	})

	test('stale lock from dead pid is reclaimed', async () => {
		// Write a fake owner.lock with a dead pid
		const { writeFileSync } = await import('fs')
		const deadPid = 2147483647 // almost certainly not running
		writeFileSync(
			`${dir}/owner.lock`,
			`{ ownerId: 'ghost', pid: ${deadPid}, createdAt: '2020-01-01T00:00:00Z' }\n`,
		)

		const result = await claimOwner('alive')
		expect(result.owner).toBe(true)
		expect(result.currentOwnerPid).toBe(process.pid)
	})

	test('no owner-claim directory is created', async () => {
		await claimOwner('a')
		expect(existsSync(`${dir}/owner-claim`)).toBe(false)
		await releaseOwner('a')
		expect(existsSync(`${dir}/owner-claim`)).toBe(false)
	})
})

describe('verifyOwnership', () => {
	test('returns true when lock matches ownerId', async () => {
		await claimOwner('a')
		expect(await verifyOwnership('a')).toBe(true)
	})

	test('returns false when lock has different ownerId', async () => {
		await claimOwner('a')
		expect(await verifyOwnership('b')).toBe(false)
	})

	test('returns false when lock file is missing', async () => {
		expect(await verifyOwnership('a')).toBe(false)
	})

	test('returns false after release', async () => {
		await claimOwner('a')
		await releaseOwner('a')
		expect(await verifyOwnership('a')).toBe(false)
	})
})