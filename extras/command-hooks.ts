// Adapts foreign command hooks at Hal's awaited tool and request boundaries (task sey).
import { realpathSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import type { Plugin } from '../src/host/plugins.ts'
import { plugins } from '../src/host/plugins.ts'
import { tools } from '../src/host/tools.ts'
import { roundStream } from '../src/host/round-stream.ts'
import { sessions } from '../src/host/sessions.ts'
import { paths } from '../src/host/paths.ts'
import { history } from '../src/host/history.ts'
import { slash } from '../src/host/slash.ts'
import { replay } from '../src/common/replay.ts'
import { dispatch, type Outcome } from './hook-command.ts'
import { load, matches, type Flavor, type Hook, type Options } from './hook-sources.ts'

export function install(plugin: Plugin, flavor: Flavor, options: Options): () => void {
	if (!isAbsolute(options.cwd) || options.sources.some((s) => !isAbsolute(s.path)))
		throw new Error('Hook cwd and source paths must be absolute')
	let root = realpathSync(options.cwd)
	let sources = options.sources.map((s) => ({ ...s, path: realpathSync(s.path) }))
	let warnings = new Set<string>()
	let checked = (): Hook[] =>
		sources.flatMap((source) => {
			let loaded = load(flavor, source)
			if (loaded.hash !== source.sha256)
				throw new Error(
					`${source.path}: untrusted ${flavor} hooks; review the configuration, then pin sha256: ${loaded.hash}`,
				)
			for (let warning of loaded.unsupported)
				if (!warnings.has(warning)) {
					warnings.add(warning)
					plugins.report(warning)
				}
			return loaded.hooks
		})
	checked()
	let active = (cwd: string) => {
		let rel = relative(root, realpathSync(cwd))
		return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
	}
	let input = (id: string, cwd: string) => ({
		session_id: id,
		cwd,
		project_root: root,
		transcript_path: null,
		permission_mode: 'default',
	})
	let deliver = (id: string, result: Outcome) => {
		for (let text of result.context) {
			history.append(id, { type: 'notice', text: `${flavor} hook context:\n${text}` })
			slash.output(id, `${flavor} hook context:\n${text}`)
		}
		for (let text of result.messages) slash.output(id, `${flavor} hook:\n${text}`)
	}
	let lifetime = new AbortController()
	let lifecycle = new WeakMap<object, { started: boolean; prompt?: number }>()
	plugin.around(tools, 'run', async (next, call, ctx) => {
		let completed: Awaited<ReturnType<typeof tools.run>> | undefined
		try {
			if (!active(ctx.cwd)) return next(call, ctx)
			let hooks = checked()
			let toolName =
				({ bash: 'Bash', read: 'Read', edit: 'Edit', grep: 'Grep' } as Record<string, string>)[call.name] ?? call.name
			let toolInput = call.input
			let singleRead =
				call.name === 'read' && typeof call.input.path === 'string' && !call.input.paths && !call.input.url
			if (singleRead)
				toolInput = { ...call.input, file_path: resolve(ctx.cwd, paths.expand(call.input.path as string)) }
			let aliases = call.name === 'edit' ? ['Edit', 'Write', 'apply_patch'] : [toolName]
			if (
				(call.name === 'edit' || call.name === 'grep' || (call.name === 'read' && !singleRead)) &&
				hooks.some((h) => h.event.includes('ToolUse') && aliases.some((name) => matches(flavor, h.matcher, name)))
			)
				throw new Error(
					`${call.name}: matching foreign file hooks require an unsupported input schema; this tool did not run. Use a native Hal policy plugin for batch edits, batch/URL reads, or grep.`,
				)
			let eventInput = {
				...input(ctx.sessionId, ctx.cwd),
				model: ctx.model,
				tool_name: toolName,
				tool_input: toolInput,
				tool_use_id: call.id,
			}
			let signal = AbortSignal.any([ctx.signal, lifetime.signal])
			let before = await dispatch(flavor, hooks, 'PreToolUse', toolName, eventInput, signal)
			deliver(ctx.sessionId, before)
			if (before.block)
				return { type: 'tool_result', id: call.id, output: `${flavor} PreToolUse: ${before.block}`, isError: true }
			signal.throwIfAborted()
			let result = (completed = await next(call, ctx))
			let event = flavor === 'claude' && result.isError ? 'PostToolUseFailure' : 'PostToolUse'
			let after = await dispatch(
				flavor,
				hooks,
				event,
				toolName,
				{
					...eventInput,
					tool_response: result.output,
					...(result.isError && { error: result.output, is_interrupt: !!result.interrupted }),
				},
				signal,
			)
			deliver(ctx.sessionId, after)
			if (after.block)
				return { ...result, output: `${result.output}\n\n${flavor} ${event} feedback: ${after.block}`, isError: true }
			return result
		} catch (e) {
			return {
				...completed,
				type: 'tool_result',
				id: call.id,
				output: `${completed ? `${completed.output}\n\n` : ''}${flavor} hook failed: ${e instanceof Error ? e.message : e}`,
				isError: true,
			}
		}
	})
	plugin.around(roundStream, 'stream', async function* (next, id, model, running, signal) {
		let cwd = sessions.open(id).cwd
		if (!active(cwd)) return yield* next(id, model, running, signal)
		try {
			let hooks = checked()
			let base = { ...input(id, cwd), model }
			let records = replay.current(history.readSync(id))
			let meta = sessions.open(id)
			let state = lifecycle.get(meta) ?? { started: false }
			lifecycle.set(meta, state)
			let combined = AbortSignal.any([signal, lifetime.signal])
			if (!state.started) {
				let source = records.some((r) => r.type === 'assistant') ? 'resume' : 'startup'
				let result = await dispatch(flavor, hooks, 'SessionStart', source, { ...base, source }, combined)
				deliver(id, result)
				if (result.block) throw new Error(`SessionStart: ${result.block}`)
				state.started = true
			}
			let user = records.findLast((r) => r.type === 'user' && r.blocks.some((b) => b.type === 'text'))
			if (user?.type === 'user' && state.prompt !== user.n) {
				let prompt = user.blocks
					.filter((b) => b.type === 'text')
					.map((b) => b.text)
					.join('\n')
				let result = await dispatch(flavor, hooks, 'UserPromptSubmit', '', { ...base, prompt }, combined)
				deliver(id, result)
				if (result.block) throw new Error(`UserPromptSubmit: ${result.block}`)
				state.prompt = user.n
			}
			combined.throwIfAborted()
			yield* next(id, model, running, signal)
		} catch (e) {
			yield { type: 'error', message: `${flavor} hook failed: ${e instanceof Error ? e.message : e}` }
		}
	})
	return () => lifetime.abort()
}
