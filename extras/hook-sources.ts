// Loads only explicitly selected hook definitions, pinned to reviewed bytes (task sey).
import { createHash } from 'crypto'
import { existsSync, readFileSync, realpathSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'

export type Flavor = 'codex' | 'claude'
export type Source = { path: string; sha256: string; package?: boolean }
export type Handler = { command: string; args?: string[]; timeout: number }
export type Hook = { event: string; matcher?: string; handler: Handler; root?: string; source: string }
export type Options = { cwd: string; sources: Source[] }
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']

export function object(value: unknown, label: string): Record<string, any> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected object`)
	return value as Record<string, any>
}

function inside(root: string, file: string): string {
	let path = realpathSync(file)
	let rel = relative(root, path)
	if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`${file}: escapes package ${root}`)
	return path
}

export function load(flavor: Flavor, source: Source): { hooks: Hook[]; hash: string; unsupported: string[] } {
	let parts: [string, string][] = []
	let root = source.package ? realpathSync(source.path) : undefined
	let read = (file: string) => {
		let path = root ? inside(root, file) : realpathSync(file)
		let text = readFileSync(path, 'utf8')
		parts.push([root ? relative(root, path) : path, text])
		return object(file.endsWith('.toml') ? Bun.TOML.parse(text) : JSON.parse(text), file)
	}
	let configs: Record<string, any>[] = []
	let unsupported: string[] = []
	if (!root) configs.push(read(resolve(source.path)))
	else {
		let manifest: Record<string, any> = {}
		let portable = join(root, 'plugin.json')
		let legacy = join(root, flavor === 'codex' ? '.codex-plugin/plugin.json' : '.claude-plugin/plugin.json')
		if (flavor === 'codex' && existsSync(portable)) {
			let base = read(portable)
			manifest = base.extensions?.['com.openai'] ?? (existsSync(legacy) ? read(legacy) : {})
		} else if (existsSync(legacy)) manifest = read(legacy)
		for (let key of [
			'skills',
			'commands',
			'agents',
			'mcpServers',
			'lspServers',
			'settings',
			'userConfig',
			'dependencies',
			'workflows',
			'experimental',
			'apps',
			'outputStyles',
			'channels',
		])
			if (manifest[key] !== undefined) unsupported.push(`${source.path}: package component ${key} is not loaded`)
		for (let name of [
			'skills',
			'commands',
			'agents',
			'.mcp.json',
			'mcp.json',
			'.lsp.json',
			'settings.json',
			'workflows',
			'monitors',
			'bin',
			'output-styles',
		])
			if (existsSync(join(root, name))) unsupported.push(`${source.path}: package component ${name} is not loaded`)
		let defaults = join(root, 'hooks/hooks.json')
		if ((flavor === 'claude' || manifest.hooks === undefined) && existsSync(defaults)) configs.push(read(defaults))
		let entries = manifest.hooks === undefined ? [] : Array.isArray(manifest.hooks) ? manifest.hooks : [manifest.hooks]
		for (let entry of entries) {
			if (typeof entry === 'string') {
				if (!entry.startsWith('./')) throw new Error(`${source.path}: hook path must start with ./`)
				let file = join(root, entry)
				if (flavor === 'claude' && resolve(file) === resolve(defaults) && existsSync(defaults)) continue
				configs.push(read(file))
			} else {
				let inline = object(entry, source.path)
				configs.push(flavor === 'claude' ? { hooks: inline } : inline)
			}
		}
	}
	let hooks: Hook[] = []
	for (let config of configs) {
		if (config.disableAllHooks === true || config.features?.hooks === false) continue
		for (let [event, groups] of Object.entries(object(config.hooks ?? {}, source.path))) {
			if (!events.includes(event) || (flavor === 'codex' && event === 'PostToolUseFailure'))
				throw new Error(`${source.path}: unsupported hook event ${event}`)
			if (!Array.isArray(groups)) throw new Error(`${source.path}: ${event} must be an array`)
			for (let value of groups) {
				let group = object(value, event)
				for (let key of Object.keys(group))
					if (!['matcher', 'hooks'].includes(key)) throw new Error(`${event}: unsupported matcher field ${key}`)
				if (group.matcher !== undefined && typeof group.matcher !== 'string')
					throw new Error(`${event}: invalid matcher`)
				if (group.matcher && group.matcher !== '*') new RegExp(group.matcher)
				if (!Array.isArray(group.hooks)) throw new Error(`${event}: hooks must be an array`)
				for (let value of group.hooks) {
					let h = object(value, event)
					for (let key of Object.keys(h))
						if (!['type', 'command', 'args', 'timeout', 'statusMessage'].includes(key))
							throw new Error(`${event}: unsupported handler field ${key}`)
					if (h.type !== 'command' || typeof h.command !== 'string' || !h.command.trim())
						throw new Error(`${event}: only command handlers are supported`)
					if (
						h.args !== undefined &&
						(flavor !== 'claude' || !Array.isArray(h.args) || h.args.some((v: unknown) => typeof v !== 'string'))
					)
						throw new Error(`${event}: unsupported args`)
					let timeout = h.timeout ?? (flavor === 'claude' && event === 'UserPromptSubmit' ? 30 : 600)
					if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)
						throw new Error(`${event}: invalid timeout`)
					hooks.push({
						event,
						matcher: group.matcher,
						handler: { command: h.command, args: h.args, timeout },
						root,
						source: source.path,
					})
				}
			}
		}
	}
	return {
		hooks,
		hash: createHash('sha256')
			.update(JSON.stringify([flavor, root, parts]))
			.digest('hex'),
		unsupported,
	}
}

export function matches(flavor: Flavor, matcher: string | undefined, value: string): boolean {
	if (!matcher || matcher === '*') return true
	if (flavor === 'claude' && /^[\w\- ,|]+$/.test(matcher)) return matcher.split(/[|,]/).some((s) => s.trim() === value)
	return new RegExp(matcher).test(value)
}
