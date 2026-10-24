// Runs trusted Pi command extensions through Hal's session-owned commands (task 0zp).
import { AsyncLocalStorage } from 'async_hooks'
import { spawn } from 'child_process'
import { plugins, type Plugin } from '../src/host/plugins.ts'
import { commands, type Context, type SlashCommand } from '../src/host/commands.ts'
import { commandList } from '../src/common/commands/list.ts'
import { literal } from '../src/common/literal.ts'
import { prompts } from '../src/host/prompts.ts'
import { turns } from '../src/host/turns.ts'

export type PiContext = { cwd: string; ui: { notify(text: string, type?: 'info' | 'warning' | 'error'): void } }
export type PiCommand = {
	description?: string
	handler(args: string, ctx: PiContext): void | Promise<void>
	getArgumentCompletions?(prefix: string): { value: string; label: string; description?: string }[] | null
}
export type PiAPI = {
	registerCommand(name: string, command: PiCommand): void
	exec(
		command: string,
		args: string[],
		options?: { cwd?: string; timeout?: number; signal?: AbortSignal },
	): Promise<{
		code: number
		stdout: string
		stderr: string
		killed: boolean
	}>
	sendUserMessage(text: string, options: { deliverAs: 'followUp' }): void
}
type Invocation = { ctx: Context; name: string; controller: AbortController }

function supported<T extends object>(value: T, label: string): T {
	return new Proxy(value, {
		get(target, key, receiver) {
			if (!Object.hasOwn(target, key)) throw new Error(`Pi adapter: unsupported ${label}.${String(key)}`)
			return Reflect.get(target, key, receiver)
		},
	})
}

export function install(
	plugin: Plugin,
	extension: (pi: PiAPI) => void,
	completions: Record<string, string[]> = {},
): () => void {
	let definitions = new Map<string, PiCommand>()
	let scope = new AsyncLocalStorage<Invocation>()
	let running = new Set<Invocation>()
	let registering = true,
		closed = false
	let current = () => {
		let invocation = scope.getStore()
		if (closed || !invocation || !running.has(invocation)) throw new Error('Pi adapter: no active command invocation')
		invocation.controller.signal.throwIfAborted()
		return invocation
	}
	let api: PiAPI = {
		registerCommand(name, command) {
			if (!registering) throw new Error('Pi adapter: registerCommand is only supported during initialization')
			if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Pi adapter: invalid command ${name}`)
			if (definitions.has(name) || commands.all().has(name) || commandList.byName(name))
				throw new Error(`Pi adapter: command collision /${name}`)
			for (let key of Object.keys(command))
				if (!['description', 'handler', 'getArgumentCompletions'].includes(key))
					throw new Error(`Pi adapter: unsupported command option ${key}`)
			definitions.set(name, command)
		},
		async exec(command, args, options = {}) {
			let invocation = current()
			for (let key of Object.keys(options))
				if (!['cwd', 'timeout', 'signal'].includes(key)) throw new Error(`Pi adapter: unsupported exec option ${key}`)
			let timeout = options.timeout ?? 30_000
			if (!Number.isFinite(timeout) || timeout <= 0)
				throw new Error('Pi adapter: timeout must be positive milliseconds')
			let signal = AbortSignal.any([invocation.controller.signal, ...(options.signal ? [options.signal] : [])])
			signal.throwIfAborted()
			return new Promise((resolve, reject) => {
				let child = spawn(command, args, {
					cwd: options.cwd ?? invocation.ctx.cwd,
					detached: true,
					stdio: ['ignore', 'pipe', 'pipe'],
				})
				let stdout = '',
					stderr = '',
					stopped = ''
				let kill = (reason: string) => {
					stopped = reason
					if (child.pid)
						try {
							process.kill(-child.pid, 'SIGKILL')
						} catch (e: any) {
							if (e.code !== 'ESRCH') reject(e)
						}
				}
				let abort = () => kill('canceled')
				let timer = setTimeout(() => kill(`timed out after ${timeout}ms`), timeout)
				signal.addEventListener('abort', abort, { once: true })
				child.stdout.setEncoding('utf8').on('data', (text) => {
					stdout += text
				})
				child.stderr.setEncoding('utf8').on('data', (text) => {
					stderr += text
				})
				let failure: Error | undefined
				child.on('error', (error) => {
					failure = error
				})
				child.on('close', (code, exitSignal) => {
					clearTimeout(timer)
					signal.removeEventListener('abort', abort)
					let detail = `${command} ${JSON.stringify(args)}: ${failure ?? (stopped || `exit ${code ?? exitSignal}`)}\nstdout:\n${stdout}\nstderr:\n${stderr}`
					if (failure || stopped) reject(new Error(detail))
					else {
						if (code !== 0) invocation.ctx.say(`Pi /${invocation.name}: ${detail}`)
						resolve({ code: code ?? 1, stdout, stderr, killed: !!exitSignal })
					}
				})
			})
		},
		sendUserMessage(text, options) {
			let { ctx, name } = current()
			if (
				typeof text !== 'string' ||
				options?.deliverAs !== 'followUp' ||
				Object.keys(options).some((key) => key !== 'deliverAs')
			)
				throw new Error('Pi adapter: sendUserMessage supports text with deliverAs: followUp only')
			let error = prompts.submit(ctx.sessionId, literal.escape(text), undefined, 'queue', {
				...ctx.sender,
				label: `Pi /${name}`,
				summary: `Pi /${name}`,
			})
			if (error) throw new Error(`Pi /${name}: ${error}`)
		},
	}
	try {
		let result = extension(supported(api, 'pi')) as unknown
		if (result instanceof Promise) {
			void result.catch((error) => plugins.report(`Pi adapter initialization: ${error}\n${error?.stack ?? ''}`))
			throw new Error('Pi adapter: extension initialization must be synchronous')
		}
	} finally {
		registering = false
	}
	let adapted = new Map<string, SlashCommand>()
	for (let [name, definition] of definitions) {
		adapted.set(name, {
			help: () => [definition.description ?? `Pi /${name}`, ...(completions[name] ?? [])].join('\n'),
			complete: (args) => {
				let prefix = args.slice(0, args.lastIndexOf(' ') + 1),
					token = args.slice(prefix.length)
				return (
					definition
						.getArgumentCompletions?.(args)
						?.map((item) => ({ value: item.value, description: item.description ?? item.label })) ??
					(completions[name] ?? []).filter((value) => value.startsWith(token)).map((value) => prefix + value)
				)
			},
			async run(args, _answers, ctx) {
				let invocation = { ctx, name, controller: new AbortController() }
				running.add(invocation)
				try {
					return await scope.run(invocation, async () => {
						current()
						await definition.handler(
							args,
							supported(
								{
									cwd: ctx.cwd,
									ui: supported(
										{
											notify(text: string, type = 'info') {
												current().ctx.say(`Pi /${name} (${type}): ${text}`)
											},
										},
										'ctx.ui',
									),
								},
								'ctx',
							),
						)
						current()
						return {}
					})
				} catch (e) {
					return {
						error: `Pi /${name}: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e)}`,
					}
				} finally {
					running.delete(invocation)
					invocation.controller.abort()
				}
			},
		})
	}
	plugin.around(commands, 'all', (next) => {
		let result = new Map(next())
		for (let [name, command] of adapted) {
			if (result.has(name)) throw new Error(`Pi adapter: command collision /${name}`)
			result.set(name, command)
		}
		return result
	})
	plugin.around(commandList, 'all', (next) => {
		let result = [...next()]
		for (let [name, definition] of definitions) {
			if (result.some((item) => item.name === name)) throw new Error(`Pi adapter: command collision /${name}`)
			result.push({ name, description: definition.description ?? `Pi /${name}`, category: 'plugins' })
		}
		return result.sort((a, b) => a.name.localeCompare(b.name))
	})
	plugin.before(turns, 'stop', (id) => {
		for (let invocation of running) if (invocation.ctx.sessionId === id) invocation.controller.abort()
	})
	return () => {
		closed = true
		for (let invocation of running) invocation.controller.abort()
	}
}
