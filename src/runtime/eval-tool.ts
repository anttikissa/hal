// In-process eval tool — executes TypeScript inside the Hal process.
// Files persist in state/sessions/<id>/eval/ for audit.

import { mkdirSync } from 'fs'
import { join } from 'path'

export interface EvalContext {
	sessionId: string
	halDir: string
	stateDir: string
	cwd: string
	runtime: unknown // Runtime instance — typed as unknown to avoid circular imports
}

let counter = 0

export async function executeEval(code: string, ctx: EvalContext): Promise<string> {
	const evalDir = join(ctx.stateDir, 'sessions', ctx.sessionId, 'eval')
	mkdirSync(evalDir, { recursive: true })

	const file = join(evalDir, `${Date.now()}-${counter++}.ts`)
	const wrapped = `export default async (ctx: any) => {\n${code}\n}\n`
	await Bun.write(file, wrapped)

	try {
		const mod = await import(file)
		const result = await mod.default(ctx)
		return result === undefined ? 'undefined' : typeof result === 'string' ? result : JSON.stringify(result)
	} catch (err: any) {
		return `${err.stack ?? err.message}`
	}
}
