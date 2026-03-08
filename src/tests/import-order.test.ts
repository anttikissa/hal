import { test, expect } from 'bun:test'

test('static import evaluates before module-level assignment', async () => {
	// Write a module that captures an env var at import time
	const mod = `
		export const captured = process.env.IMPORT_ORDER_TEST ?? 'NOT_SET'
	`
	const modPath = '/tmp/hal-import-order-mod.ts'
	await Bun.write(modPath, mod)

	// Write a script that sets env THEN imports
	const script = `
		process.env.IMPORT_ORDER_TEST = 'SET_BEFORE_IMPORT'
		import { captured } from '${modPath}'
		process.stdout.write(captured)
	`
	const scriptPath = '/tmp/hal-import-order-script.ts'
	await Bun.write(scriptPath, script)

	const proc = Bun.spawn(['bun', scriptPath], { stdout: 'pipe', stderr: 'pipe' })
	const out = await new Response(proc.stdout).text()
	await proc.exited

	// The env var assignment appears before the import in source,
	// but imports are hoisted — the module evaluates first
	expect(out).toBe('NOT_SET')
})
