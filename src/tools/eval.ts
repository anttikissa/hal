// Eval tool — execute TypeScript inside the Hal process.
//
// The power tool: lets the agent inspect and modify its own runtime.
// Code is written to a temp file and imported, so it has full access
// to all modules. Files persist in state/sessions/<id>/eval/ for audit.

import { mkdirSync } from 'fs'
import { join } from 'path'
import { toolRegistry, type ToolContext } from './tool.ts'
import { STATE_DIR } from '../state.ts'

let counter = 0

const config = {
	/** Default eval timeout in ms. */
	timeout: 10_000,
}

async function execute(input: any, ctx: ToolContext): Promise<string> {
	const code = String(input?.code ?? '')
	if (!code.trim()) return 'error: empty code'

	// Persist eval code for audit trail
	const evalDir = join(STATE_DIR, 'sessions', ctx.sessionId, 'eval')
	mkdirSync(evalDir, { recursive: true })
	const file = join(evalDir, `${Date.now()}-${counter++}.ts`)

	// Separate import lines from body, then wrap body in an async function.
	// This lets the code use `return` to produce a value and `import` for modules.
	const lines = code.split('\n')
	const imports: string[] = []
	const body: string[] = []
	for (const line of lines) {
		if (/^\s*import\s/.test(line)) imports.push(line)
		else body.push(line)
	}

	const wrapped = [
		...imports,
		imports.length ? '' : undefined,
		'export default async (ctx: any) => {',
		...body,
		'}',
		'',
	].filter(l => l !== undefined).join('\n')

	await Bun.write(file, wrapped)

	try {
		const mod = await import(file)
		const evalCtx = {
			sessionId: ctx.sessionId,
			cwd: ctx.cwd,
			halDir: join(STATE_DIR, '..'),
			stateDir: STATE_DIR,
			signal: ctx.signal,
		}

		// Race eval against abort signal and timeout
		const run = mod.default(evalCtx)
		const promises: Promise<any>[] = [run]

		// Abort promise: rejects if signal fires
		if (ctx.signal) {
			promises.push(new Promise<never>((_, reject) => {
				if (ctx.signal!.aborted) reject(new DOMException('Aborted', 'AbortError'))
				else ctx.signal!.addEventListener('abort', () =>
					reject(new DOMException('Aborted', 'AbortError')), { once: true })
			}))
		}

		// Timeout promise
		promises.push(new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`eval timed out after ${config.timeout}ms`)), config.timeout)))

		const result = await Promise.race(promises)
		if (result === undefined) return 'undefined'
		return typeof result === 'string' ? result : JSON.stringify(result)
	} catch (err: any) {
		if (ctx.signal?.aborted) return '[interrupted]'
		return `${err.stack ?? err.message}`
	}
}

toolRegistry.registerTool({
	name: 'eval',
	description: 'Execute TypeScript in the Hal process. Has access to runtime internals via ctx (sessionId, cwd, halDir, stateDir). Use `return` to return a value. Use standard `import` for module access.',
	parameters: {
		code: { type: 'string', description: 'TypeScript code. Imports go at top, body is wrapped in async function with ctx in scope.' },
	},
	required: ['code'],
	execute,
})

export const evalTool = { config, execute }
