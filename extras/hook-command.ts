// Runs reviewed command hooks without sharing their terminal or hiding failures (task sey).
import { spawn } from 'child_process'
import type { Flavor, Hook } from './hook-sources.ts'
import { matches, object } from './hook-sources.ts'

export type Outcome = { context: string[]; messages: string[]; block?: string }

export async function command(hook: Hook, input: Record<string, unknown>, signal?: AbortSignal): Promise<Outcome> {
	let env = { ...process.env, CLAUDE_PROJECT_DIR: String(input.project_root) }
	if (hook.root) Object.assign(env, { PLUGIN_ROOT: hook.root, CLAUDE_PLUGIN_ROOT: hook.root })
	let expand = (value: string) =>
		value.replace(
			/\$\{(CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g,
			(_, key: string) => env[key as keyof typeof env] ?? '',
		)
	if (
		/\$\{user_config\.|\b(?:CLAUDE_PLUGIN_DATA|PLUGIN_DATA)\b/.test(
			[hook.handler.command, ...(hook.handler.args ?? [])].join(' '),
		)
	)
		throw new Error(`${hook.source}: user_config and plugin data variables are unsupported`)
	let args = hook.handler.args
	let argv = args ? [expand(hook.handler.command), ...args.map(expand)] : ['/bin/sh', '-c', hook.handler.command]
	signal?.throwIfAborted()
	let output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		let child = spawn(argv[0]!, argv.slice(1), {
			cwd: String(input.cwd),
			env,
			detached: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		let stdout = '',
			stderr = '',
			stopped = ''
		let kill = (why: string) => {
			stopped = why
			if (child.pid)
				try {
					process.kill(-child.pid, 'SIGKILL')
				} catch (e: any) {
					if (e.code !== 'ESRCH') reject(e)
				}
		}
		let abort = () => kill('canceled')
		let timer = setTimeout(() => kill(`timed out after ${hook.handler.timeout}s`), hook.handler.timeout * 1000)
		signal?.addEventListener('abort', abort, { once: true })
		child.stdout.setEncoding('utf8').on('data', (s) => {
			stdout += s
		})
		child.stderr.setEncoding('utf8').on('data', (s) => {
			stderr += s
		})
		child.stdin.on('error', (e: NodeJS.ErrnoException) => {
			if (e.code !== 'EPIPE') reject(e)
		})
		child.on('error', (error) =>
			reject(new Error(`${hook.source}: ${hook.handler.command}: ${error}\nstdout:\n${stdout}\nstderr:\n${stderr}`)),
		)
		child.on('close', (code) => {
			clearTimeout(timer)
			signal?.removeEventListener('abort', abort)
			if (stopped)
				reject(new Error(`${hook.source}: ${hook.handler.command}: ${stopped}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
			else resolve({ code, stdout, stderr })
		})
		child.stdin.end(JSON.stringify(input))
	})
	let result: Outcome = { context: [], messages: [] }
	if (output.code === 2)
		return { ...result, block: [output.stderr, output.stdout].filter(Boolean).join('\n') || 'Blocked by hook (exit 2)' }
	if (output.code !== 0)
		throw new Error(
			`${hook.source}: ${hook.handler.command}: exit ${output.code}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
		)
	if (output.stderr) result.messages.push(output.stderr)
	let text = output.stdout.trim()
	if (!text) return result
	if (!text.startsWith('{')) {
		if (['SessionStart', 'UserPromptSubmit'].includes(hook.event)) result.context.push(output.stdout)
		else result.messages.push(output.stdout)
		return result
	}
	try {
		let value = object(JSON.parse(text), 'hook output')
		for (let key of Object.keys(value))
			if (
				![
					'hookSpecificOutput',
					'decision',
					'reason',
					'continue',
					'stopReason',
					'systemMessage',
					'suppressOutput',
				].includes(key)
			)
				throw new Error(`unsupported output ${key}`)
		let specific = value.hookSpecificOutput === undefined ? {} : object(value.hookSpecificOutput, 'hookSpecificOutput')
		for (let key of Object.keys(specific))
			if (!['hookEventName', 'additionalContext', 'permissionDecision', 'permissionDecisionReason'].includes(key))
				throw new Error(`unsupported output ${key}`)
		if (specific.hookEventName !== undefined && specific.hookEventName !== hook.event)
			throw new Error('hookEventName does not match event')
		if (
			specific.permissionDecision !== undefined &&
			(hook.event !== 'PreToolUse' || !['allow', 'deny'].includes(specific.permissionDecision))
		)
			throw new Error('unsupported permissionDecision')
		if (value.decision !== undefined && value.decision !== 'block') throw new Error('unsupported decision')
		for (let [key, v] of Object.entries({
			reason: value.reason,
			stopReason: value.stopReason,
			systemMessage: value.systemMessage,
			additionalContext: specific.additionalContext,
			permissionDecisionReason: specific.permissionDecisionReason,
		}))
			if (v !== undefined && typeof v !== 'string') throw new Error(`${key} must be a string`)
		if (value.continue !== undefined && typeof value.continue !== 'boolean') throw new Error('continue must be boolean')
		if (value.suppressOutput !== undefined && typeof value.suppressOutput !== 'boolean')
			throw new Error('suppressOutput must be boolean')
		if (specific.additionalContext) result.context.push(specific.additionalContext)
		if (value.systemMessage) result.messages.push(value.systemMessage)
		if (specific.permissionDecision === 'deny' || value.decision === 'block' || value.continue === false)
			result.block = specific.permissionDecisionReason || value.reason || value.stopReason || 'Blocked by hook'
		return result
	} catch (e) {
		throw new Error(
			`${hook.source}: ${hook.handler.command}: ${e}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
		)
	}
}

export async function dispatch(
	flavor: Flavor,
	hooks: Hook[],
	event: string,
	value: string,
	input: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<Outcome> {
	let settled = await Promise.allSettled(
		hooks
			.filter((h) => h.event === event && (event === 'UserPromptSubmit' || matches(flavor, h.matcher, value)))
			.map((h) => command(h, { ...input, hook_event_name: event }, signal)),
	)
	let failures = settled.filter((r) => r.status === 'rejected')
	let results = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value)
	return {
		context: results.flatMap((r) => r.context),
		messages: results.flatMap((r) => r.messages),
		block:
			[...results.map((r) => r.block), ...failures.map((r) => `Hook failed: ${String(r.reason)}`)]
				.filter(Boolean)
				.join('\n') || undefined,
	}
}
