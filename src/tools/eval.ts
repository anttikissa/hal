// Eval tool — execute TypeScript inside the Hal process.
// Files persist in state/sessions/<id>/eval/ for audit.

import { mkdirSync } from 'fs'
import { join } from 'path'
import { defineTool, previewField } from './tool.ts'
import type { ToolContext } from './tool.ts'

export interface EvalContext {
	sessionId: string
	halDir: string
	stateDir: string
	cwd: string
	runtime: unknown // typed as unknown to avoid circular imports
}

let counter = 0

export async function executeEval(code: string, ctx: EvalContext): Promise<string> {
	const evalDir = join(ctx.stateDir, 'sessions', ctx.sessionId, 'eval')
	mkdirSync(evalDir, { recursive: true })

	const file = join(evalDir, `${Date.now()}-${counter++}.ts`)

	const lines = code.split('\n')
	const imports: string[] = []
	const body: string[] = []
	for (const line of lines) {
		if (/^\s*import\s/.test(line)) imports.push(line)
		else body.push(line)
	}
	const wrapped = `${imports.join('\n')}${imports.length ? '\n' : ''}export default async (ctx: any) => {\n${body.join('\n')}\n}\n`
	await Bun.write(file, wrapped)

	try {
		const mod = await import(file)
		const result = await mod.default(ctx)
		return result === undefined ? 'undefined' : typeof result === 'string' ? result : JSON.stringify(result)
	} catch (err: any) {
		return `${err.stack ?? err.message}`
	}
}

async function execute(input: unknown, ctx: ToolContext): Promise<string> {
	const evalCtx = ctx.evalCtx as EvalContext | undefined
	if (!evalCtx) return 'error: eval tool is not enabled (set eval: true in config.ason)'
	if (!evalCtx.runtime) {
		const { runtimeCore } = await import('../runtime/runtime.ts')
		try { evalCtx.runtime = runtimeCore.getRuntime() } catch {}
	}
	return executeEval(String((input as any).code), evalCtx)
}

export const evalModule = defineTool({
	definition: {
		name: 'eval',
		description: 'Execute TypeScript in the Hal process. Has access to runtime internals via ctx object (sessionId, halDir, stateDir, cwd). Use `~src/` prefix in imports to reference Hal source.',
		input_schema: {
			type: 'object' as const,
			properties: {
				code: { type: 'string', description: 'TypeScript function body. `ctx` is in scope. Use `return` to return a value.' },
			},
			required: ['code'],
		},
	},
	argsPreview: (input: unknown) => previewField('code')(input).slice(0, 80),
	execute,
})
