import { webConnection } from './web-connection.ts'

function open(host: string, authToken: string, signal: AbortSignal): Promise<void> {
	return webConnection.connect(host, authToken, signal)
}

function prompt(message: string): string | null {
	return globalThis.prompt(message)
}

function write(text: string): void {
	process.stderr.write(text)
}

async function connect(host: string, authToken: string | null, signal: AbortSignal): Promise<string> {
	if (authToken) {
		try {
			await remoteAuth.open(host, authToken, signal)
			return authToken
		} catch (error) {
			if (!(error instanceof Error) || error.message !== 'Invalid authentication token') throw error
			remoteAuth.write(`Invalid token connecting to ${host}.\n`)
		}
	}
	if (!authToken) remoteAuth.write(`No auth token stored for ${host}.\n`)
	remoteAuth.write(`To get a new token, on the remote server, run \`hal auth\`.\n`)
	const replacement = remoteAuth.prompt('Enter auth token:')?.trim()
	if (!replacement) throw new Error('Authentication cancelled')
	await remoteAuth.open(host, replacement, signal)
	return replacement
}

export const remoteAuth = { open, prompt, write, connect }
