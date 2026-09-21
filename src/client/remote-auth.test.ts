import { afterEach, expect, test } from 'bun:test'
import { remoteAuth } from './remote-auth.ts'

const originalOpen = remoteAuth.open
const originalPrompt = remoteAuth.prompt
const originalWrite = remoteAuth.write

afterEach(() => {
	remoteAuth.open = originalOpen
	remoteAuth.prompt = originalPrompt
	remoteAuth.write = originalWrite
})

test('prompts for a replacement after an invalid remembered token', async () => {
	const attempts: string[] = []
	let output = ''
	let question = ''
	remoteAuth.open = async (_host, token) => {
		attempts.push(token)
		if (token === 'old') throw new Error('Invalid authentication token')
	}
	remoteAuth.prompt = (message) => { question = message; return ' new ' }
	remoteAuth.write = (text) => { output += text }

	const token = await remoteAuth.connect('hal.example', 'old', new AbortController().signal)

	expect(token).toBe('new')
	expect(attempts).toEqual(['old', 'new'])
	expect(question).toBe('Enter auth token:')
	expect(output).toContain('Invalid token connecting to hal.example.')
	expect(output).toContain('run `hal auth`')
})

test('explains when no token is remembered before prompting', async () => {
	const attempts: string[] = []
	let output = ''
	remoteAuth.open = async (_host, token) => { attempts.push(token) }
	remoteAuth.prompt = () => 'first'
	remoteAuth.write = (text) => { output += text }

	expect(await remoteAuth.connect('hal.example', null, new AbortController().signal)).toBe('first')
	expect(attempts).toEqual(['first'])
	expect(output).toContain('No auth token stored for hal.example.')
})

test('does not replace tokens after unrelated connection failures', async () => {
	remoteAuth.open = async () => { throw new Error('network down') }
	remoteAuth.prompt = () => { throw new Error('should not prompt') }
	remoteAuth.write = () => {}

	await expect(remoteAuth.connect('hal.example', 'old', new AbortController().signal)).rejects.toThrow('network down')
})
