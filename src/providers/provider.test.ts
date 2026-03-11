import { test, expect, afterEach } from 'bun:test'
import { provider } from './provider.ts'

const defaultTimeout = provider.config.streamTimeoutMs

afterEach(() => {
	provider.config.streamTimeoutMs = defaultTimeout
})

test('readWithTimeout uses live config', async () => {
	provider.config.streamTimeoutMs = 1
	const stream = new ReadableStream<Uint8Array>({ start() {} })
	const reader = stream.getReader()
	await expect(provider.readWithTimeout(reader)).rejects.toThrow('timed out')
})
