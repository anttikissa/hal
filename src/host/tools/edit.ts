// EDIT (task ybg): one atomic batch of line and text operations across
// files, written !!OLD/!!NEW/!!END. Creates, rewrites and deletes files
// too, so there is no separate WRITE. The parser is strict;
// model-specific leniency lives in extras/edit-quirks.ts.
import { readFile, mkdir, mkdtemp, writeFile, link, unlink, rm, lstat, rename, chmod, open } from 'fs/promises'
import { randomUUID } from 'crypto'
import { dirname, resolve } from 'path'
import { tools, type Tool, type ToolContext } from '../tools.ts'
import { nativeTool } from '../native-tool.ts'
import { approval } from '../approval.ts'
import { fileChanges } from '../file-changes.ts'
import { fileText, type Change } from '../file-text.ts'
import { textDiff } from '../text-diff.ts'
import { paths } from '../paths.ts'

type Plan = { path: string; before: Buffer | null; next: Buffer | null; ranges: Change[]; mode?: number; kind?: string; diff?: string }
const N = String.fromCharCode(10)
const help = [
	'Apply one atomic batch of operations across files. Each operation is a header line, followed by its block:',
	'  <path>@<version> replace A-B       then !!NEW, new lines, !!END',
	'  <path>@<version> insert-before N   then !!NEW ... !!END',
	'  <path>@<version> insert-after N    then !!NEW ... !!END',
	'  <path>@<version> delete A-B        (no block)',
	'  <path>@<version> delete            (no block; deletes the file)',
	'  <path> replace                     then !!OLD, exact old text, !!NEW, new text, !!END (old must match exactly once)',
	'  <path> create                      then !!NEW ... !!END (file must not exist)',
	'  <path>@<version> write             then !!NEW, whole new contents, !!END',
	'Block content is literal: no quoting or escaping. Only a content line that is itself a marker needs one extra ! ' +
	'(write !!!END for a literal !!END line). Always submit the <version> READ gave (<path>@<version>); line numbers ' +
	'are 1-based, inclusive and all refer to that version. Text replaces apply after a file\'s line operations. ' +
	'Nothing is written unless every operation validates. Results show verified diffs and new versions; no ' +
	'confirmation READ is needed.',
].join(N)

// The edits a block-format EDIT text stands for. Throws with the line at fault.
export function parseBlocks(raw: string): { edits: Record<string, unknown>[]; then?: string[]; purpose?: string } {
	const lines = raw.split(N).map((l) => l.replace(/\r$/, ''))
	let purpose: string | undefined, i = 0
	const first = lines[0]!.trim()
	if (first.startsWith('/*')) {
		const close = raw.indexOf('*/')
		if (close < 0) throw new Error('EDIT: unclosed /* purpose comment; close it with */')
		purpose = raw.slice(raw.indexOf('/*') + 2, close).trim().replace(/\s+/g, ' ') || undefined
		const rest = raw.slice(close + 2)
		return { ...parseBlocks(rest.startsWith(N) || rest.startsWith(' ') ? rest : N + rest), ...(purpose && { purpose }) }
	}
	const marker = (l: string) => /^!!(OLD|NEW|END)$/.exec(l)?.[1]
	const content = (l: string) => /^!!!+(OLD|NEW|END)$/.test(l) ? l.slice(1) : l
	const block = (until: string[], at: number): [string[], string, number] => {
		const out: string[] = []
		for (let j = at; j < lines.length; j++) {
			const m = marker(lines[j]!)
			if (m && until.includes(m)) return [out, m, j + 1]
			if (m) throw new Error(`EDIT line ${j + 1}: unexpected !!${m} inside a block; a literal marker line takes one extra ! (!!!${m})`)
			out.push(content(lines[j]!))
		}
		throw new Error(`EDIT line ${at}: block never closed; end it with !!${until.join(' or !!')}`)
	}
	const edits: Record<string, unknown>[] = [], then: string[] = []
	const known = (l: string) => {
		const m = /^([A-Z][A-Z_]*)(?=\s|\/\*|$)/.exec(l)?.[1];
		return m && tools.all().has(m.toLowerCase()) ? m : undefined
	}
	while (i < lines.length) {
		const line = lines[i]!.trim(), at = i + 1
		if (!line) {
			i++;
			continue
		}
		// Calls after the last block run, in order, once the edit succeeds.
		if (edits.length && known(lines[i]!)) {
			let chunk: string[] = []
			for (const l of lines.slice(i)) {
				if (known(l) && chunk.length && known(chunk[0]!) !== 'EDIT') {
					then.push(chunk.join(N).trimEnd());
					chunk = []
				}
				chunk.push(l)
			}
			then.push(chunk.join(N).trimEnd())
			break
		}
		const h = /^(.+?)(?:@([A-Za-z0-9]+))? (replace|insert-before|insert-after|delete|create|write)(?: (\d+)(?:-(\d+))?)?\s*$/.exec(line)
		if (!h) throw new Error(`EDIT line ${at}: expected "<path>@<version> <operation> [lines]", got ${JSON.stringify(line.slice(0, 120))}. Operations: replace A-B, insert-before N, insert-after N, delete A-B, delete (file), replace (text), create, write`)
		const [, path, hash, op, a, b] = h
		const need = (ok: boolean, what: string) => {
			if (!ok) throw new Error(`EDIT line ${at}: ${op} ${what}`)
		}
		const open = (name: string) => {
			need(marker(lines[i + 1] ?? '') === name, `must be followed by !!${name} on the next line`);
			i += 2
		}
		const range = a === undefined ? undefined : b === undefined ? a : `${a}-${b}`
		// The version is advisory: checked when given, never required.
		const v = hash ? { hash } : {}
		if (op === 'replace' && range === undefined) {
			open('OLD')
			const [old, end, j] = block(['NEW', 'END'], i);
			i = j
			// Undocumented tolerance: !!OLD closed by !!END removes the text.
			let next: string[] = []
			if (end === 'NEW') [next, , i] = block(['END'], i)
			need(old.join(N).length > 0, 'needs nonempty old text')
			edits.push({ path, old: old.join(N), new: next.join(N), ...v })
		} else if (op === 'delete' && range === undefined) {
			edits.push({ path, ...v, delete: true })
			i++
		} else if (op === 'replace' || op === 'delete') {
			need(range !== undefined, 'needs a line range A-B')
			let body: string[] = []
			if (op === 'replace') {
				open('NEW');
				const [c, , j] = block(['END'], i);
				body = c;
				i = j
			} else i++
			edits.push({ path, ...v, range, lines: body })
		} else if (op === 'insert-before' || op === 'insert-after') {
			need(a !== undefined && b === undefined, 'needs one line number')
			open('NEW');
			const [c, , j] = block(['END'], i);
			i = j
			edits.push({ path, ...v, insert: Number(a) + (op === 'insert-after' ? 1 : 0), lines: c })
		} else {
			need(range === undefined, 'takes no line numbers')
			open('NEW');
			const [c, , j] = block(['END'], i);
			i = j
			edits.push({
				path,
				new: c.length ? c.join(N) + N : '', ...(op === 'write' && v), ...(op === 'create' && { create: true })
			})
		}
	}
	if (!edits.length) throw new Error(`EDIT needs at least one operation.${N}${help}`)
	return { edits, ...(then.length && { then }), ...(purpose && { purpose }) }
}

const load = (path: string): Promise<Buffer | null> => readFile(path).catch((e) => {
	if (e.code === 'ENOENT') return null;
	throw e
})
const check = (ctx: ToolContext) => {
	if (ctx.signal.aborted) throw new Error('stopped; nothing further written')
}

export const io = {
	async save(path: string, next: Buffer | null, before: Buffer | null, committed = () => {
	}, restoreMode?: number) {
		const info = await lstat(path).catch((e) => {
			if (e.code === 'ENOENT') return null;
			throw e
		}), temp = `${dirname(path)}/.hal-multi-${randomUUID()}`
		if (info?.isSymbolicLink() || await fileChanges.canonical(path) !== path) throw new Error(`${path}: target identity changed`)
		if (next === null) {
			if (!before || !info?.isFile() || !(await readFile(path)).equals(before)) throw new Error(`${path}: changed outside Hal`)
			const now = await lstat(path)
			if (await fileChanges.canonical(path) !== path || now.ino !== info.ino || now.dev !== info.dev || now.isSymbolicLink()) throw new Error(`${path}: target identity changed`)
			await unlink(path)
			committed()
			return
		}
		let failure: unknown, created = false
		try {
			const mode = restoreMode ?? (info ? info.mode & 0o7777 : 0o666 & ~process.umask()), file = await open(temp, 'wx', mode);
			created = true
			try {
				await file.writeFile(next)
			} catch (e) {
				failure = e
			}
			try {
				await file.close()
			} catch (e: any) {
				failure = new Error(`${failure ?? ''}; close ${temp}: ${e.message}`)
			}
			if (failure) throw failure
			await chmod(temp, mode)
			const now = await lstat(path).catch((e) => {
				if (e.code === 'ENOENT') return null;
				throw e
			})
			if (await fileChanges.canonical(path) !== path || (before ? !now || !info || now.ino !== info.ino || now.dev !== info.dev || !(await readFile(path)).equals(before) : now !== null)) throw new Error(`${path}: changed outside Hal`)
			if (before) await rename(temp, path); else await link(temp, path)
			committed()
		} catch (e) {
			failure = e
		}
		try {
			if (created) await unlink(temp)
		} catch (e: any) {
			if (e.code !== 'ENOENT') failure = new Error(`${failure ?? ''}; cleanup ${temp}: ${e.message}`)
		}
		if (failure) throw failure
	},
}

const fields: Record<string, unknown> = {
	path: { type: 'string' },
	old: { type: 'string', minLength: 1 },
	count: { type: 'integer', minimum: 1 },
	new: { type: 'string' },
	hash: { type: 'string', minLength: 1 },
	lines: { type: 'array', items: { type: 'string' } },
	insert: { type: 'integer', minimum: 1 },
	create: { const: true },
	delete: { const: true },
	range: {
		anyOf: [{ type: 'string' }, { type: 'integer' }, {
			type: 'array',
			items: { type: 'integer' },
			minItems: 1,
			maxItems: 2
		}]
	}
}
export const tool: Tool = {
	name: 'edit', description: help,
	syntax: {
		summary: false,
		usage: ['EDIT                                     // Exception: EDIT takes lines, not literals.', '<path>@<version> replace A-B             // One or more operations; HELP EDIT lists all.', '!!NEW', '<new lines>                              // Literal text up to !!END.', '!!END'],
		resolve(raw, ctx) {
			const { edits, then, purpose } = parseBlocks(raw)
			// Validate trailing calls before anything is written; one that needs
			// approval must come as its own call, so approval still sees it.
			for (const text of then ?? []) {
				let r: { name: string; input: Record<string, unknown> }
				try {
					r = nativeTool.resolve(text, ctx)
				} catch (e: any) {
					throw new Error(`EDIT: the tool call after the last !!END is invalid; nothing written: ${e.message}`)
				}
				if (approval.form({
					type: 'tool_call',
					id: 'then',
					name: r.name,
					input: r.input
				} as any)) throw new Error(`EDIT: the ${r.name.toUpperCase()} after the last !!END needs approval; nothing written. Send it as its own call.`)
			}
			return {
				name: 'edit',
				input: { edits, ...(then?.length && { then }), ...(purpose && { description: purpose }) }
			}
		}
	},
	parameters: {
		type: 'object', additionalProperties: false, required: ['edits'], properties: {
			description: {
				type: 'string',
				minLength: 1,
				description: 'Brief human-readable purpose of this batch'
			}, then: { type: 'array', items: { type: 'string' } }, edits: {
				type: 'array', minItems: 1, items: {
					anyOf: [
						['path', 'old', 'new'], ['path', 'old', 'new', 'hash'], ['path', 'old', 'new', 'count'], ['path', 'old', 'new', 'hash', 'count'], ['path', 'range', 'lines'], ['path', 'hash', 'range', 'lines'], ['path', 'insert', 'lines'], ['path', 'hash', 'insert', 'lines'], ['path', 'new'], ['path', 'new', 'create'], ['path', 'hash', 'new'], ['path', 'delete'], ['path', 'hash', 'delete'],
					].map((required) => ({
						type: 'object',
						additionalProperties: false,
						required,
						properties: Object.fromEntries(required.map((key) => [key, fields[key]]))
					}))
				}
			}
		}
	},
	async run(input, ctx) {
		if (Object.keys(input).some((k) => k !== 'edits' && k !== 'description' && k !== 'then')) throw new Error('only edits, then and description are accepted')
		if (input.description !== undefined && (typeof input.description !== 'string' || !input.description.trim())) throw new Error('description must be nonempty text')
		if (!Array.isArray(input.edits) || !input.edits.length) throw new Error('edits must be a nonempty list')
		const edits = input.edits as Record<string, unknown>[]
		for (const e of edits) {
			if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('each edit must be an object')
			fileChanges.validateFile(e.path)
			if (Object.keys(e).some((k) => !['path', 'old', 'new', 'hash', 'range', 'lines', 'count', 'insert', 'create', 'delete'].includes(k))) throw new Error(`unknown edit field: ${JSON.stringify(e)}`)
		}
		const observation = await fileChanges.begin(ctx, edits.map((e) => e.path as string), true)
		const plans = new Map<string, Plan>(), failures: string[] = [], written: Plan[] = []
		let recovery = '', keep = false, failure: unknown, result: string | undefined
		try {
			result = await (async () => {
				// Line operations refer to the read version, so each file's run before its text replaces.
				const rank = (e: Record<string, unknown>) => e.old === undefined && (e.range !== undefined || e.insert !== undefined) ? 0 : 1
				for (const [i, e] of [...edits.entries()].sort((a, b) => rank(a[1]) - rank(b[1]))) try {
					check(ctx)
					const path = await fileChanges.canonical(resolve(ctx.cwd, e.path as string))
					let p = plans.get(path)
					if (!p) {
						const before = await load(path)
						if (before && before.length > tools.maxFileBytes) throw new Error(`${path} is too large`)
						if (before) fileText.text(before, path)
						plans.set(path, p = { path, before, next: before ?? Buffer.alloc(0), ranges: [] })
					}
					const kind = e.delete !== undefined ? 'whole' : e.old !== undefined ? 'text' : e.range !== undefined || e.insert !== undefined ? 'range' : 'whole'
					if ('count' in e && (kind !== 'text' || e.range !== undefined || e.lines !== undefined || !Number.isSafeInteger(e.count) || (e.count as number) < 1)) throw new Error('count requires exact text and a positive safe integer')
					if (p.kind && (p.kind === 'whole' || kind === 'whole')) throw new Error('a whole-file write cannot be combined with other edits of the same file (including deletion)')
					if (e.hash !== undefined && (typeof e.hash !== 'string' || !p.before || fileText.hash(p.before) !== e.hash)) throw new Error(`${e.path}: stale version; READ again`)
					if (e.delete !== undefined) {
						if (e.delete !== true || !p.before || Object.keys(e).some((k) => !['path', 'hash', 'delete'].includes(k))) throw new Error('file deletion requires an existing file, without other selectors')
						p.mode = (await lstat(path)).mode & 0o7777
						p.next = null
					} else if (kind === 'range') {
						if (e.old !== undefined || e.new !== undefined || !p.before) throw new Error('line operations need an existing file; use lines, not new')
						if (!Array.isArray(e.lines) || !e.lines.every((l) => typeof l === 'string')) throw new Error('lines must be strings')
						const plan = p
						// Inserts at one point join in written order; an insert at a range's start leads it.
						const add = (c: Change) => {
							const insert = (r: Change) => r.end === r.start - 1,
								same = plan.ranges.find((r) => r.start === c.start)
							if (!same || !(insert(c) || insert(same))) return void plan.ranges.push(c)
							if (insert(same)) plan.ranges.splice(plan.ranges.indexOf(same), 1, {
								...c,
								lines: [...same.lines, ...c.lines]
							})
							else same.lines = [...c.lines, ...same.lines]
						}
						if (e.insert !== undefined) {
							const n = fileText.text(p.before, path).lines.length
							if (!Number.isSafeInteger(e.insert) || (e.insert as number) < 1 || (e.insert as number) > n + 1) throw new Error(`insert point outside the file's ${n} lines`)
							add({
								start: e.insert as number,
								end: (e.insert as number) - 1,
								lines: e.lines as string[]
							})
						} else add({ ...fileText.range(e.range), lines: e.lines as string[] })
						p.next = Buffer.from(fileText.apply(fileText.text(p.before, path), p.ranges).after)
					} else {
						if (e.range !== undefined || e.lines !== undefined || typeof e.new !== 'string') throw new Error('text/whole-file edits require new text, without range or lines')
						if (kind === 'text') {
							if (!p.before || typeof e.old !== 'string' || !e.old) throw new Error('old must be nonempty text in an existing file')
							const text = p.next!.toString(), at = text.indexOf(e.old), expected = e.count ?? 1
							if (at < 0) throw new Error(`old not found in planned text (matched 0 times; count requires ${expected}); check exact whitespace and surrounding context`)
							let count = 0, matches: number[] = []
							for (let pos = at; pos >= 0; pos = text.indexOf(e.old, pos + e.old.length)) {
								count++;
								if (matches.length < 2) matches.push(text.slice(0, pos).split(String.fromCharCode(10)).length)
							}
							if (count !== expected) {
								const lines = fileText.text(p.next!, path).lines.map((l) => l.length > 300 ? l.slice(0, 300) + '… [line cut]' : l)
								const contexts = matches.map((n) => fileText.numbered(lines, Array.from({ length: Math.min(lines.length, n + 2) - Math.max(1, n - 2) + 1 }, (_, j) => Math.max(1, n - 2) + j)))
								throw new Error(`old matched ${count} times; count requires ${expected}. Set count to the exact intended number, extend old with surrounding context, or use version-checked ranges. First two matches in planned text after earlier steps (not a READ version):${String.fromCharCode(10)}${contexts.join(String.fromCharCode(10) + '…' + String.fromCharCode(10))}`)
							}
							// Removing whole lines also removes their newline, leaving no blank line.
							const line = e.new === '' && count === 1 && (at === 0 || text[at - 1] === N) && text[at + e.old.length] === N
							p.next = Buffer.from(line ? text.slice(0, at) + text.slice(at + e.old.length + 1) : text.split(e.old).join(e.new))
						} else {
							if (e.create && p.before) throw new Error('create: file exists; READ it and use write with its version')
							p.next = Buffer.from(e.new)
						}
					}
					if (p.next && p.next.length > tools.maxFileBytes) throw new Error(`${path}: result is too large`)
					p.kind = kind
				} catch (e: any) {
					failures.push(`step ${i + 1} (${edits[i]!.path}): ${e.message}`)
				}
				if (failures.length) throw new Error(`Nothing written: ${failures.join('; ')}`)
				const changed = [...plans.values()].filter((p) => p.next === null || !p.before?.equals(p.next))
				for (const p of changed) {
					p.diff = textDiff.text(p.before?.toString() ?? '', p.next?.toString() ?? '', Infinity, true)
					const now = await load(p.path)
					if (p.before ? !now?.equals(p.before) : now !== null) throw new Error(`${p.path} changed while planning; nothing written`)
				}
				check(ctx)
				if (!changed.length) return 'Unchanged; nothing written.'
				await mkdir(paths.tmpDir(), { recursive: true })
				recovery = await mkdtemp(`${paths.tmpDir()}/multiedit-`)
				await writeFile(`${recovery}/manifest.json`, JSON.stringify(changed.map((p, i) => ({
					path: p.path,
					backup: p.before ? `${i}` : null
				}))), { mode: 0o600 })
				for (const [i, p] of changed.entries()) if (p.before) await writeFile(`${recovery}/${i}`, p.before, { mode: 0o600 })
				try {
					for (const p of changed) {
						check(ctx)
						await mkdir(dirname(p.path), { recursive: true })
						await io.save(p.path, p.next, p.before, () => {
							written.push(p)
						})
						const saved = await load(p.path)
						if (p.next === null ? saved !== null : !saved?.equals(p.next)) throw new Error(`${p.path}: disk verification failed`)
						check(ctx)
					}
				} catch (error: any) {
					const rollback: string[] = []
					for (const p of written.reverse()) try {
						const now = await load(p.path)
						if (p.next === null ? now !== null : !now?.equals(p.next)) throw new Error('changed externally; refusing to overwrite')
						if (p.before) await io.save(p.path, p.before, p.next, undefined, p.mode)
						else await unlink(p.path)
					} catch (e: any) {
						rollback.push(`${p.path}: ${e.message}`)
					}
					keep = rollback.length > 0
					throw new Error(`${error.message}
${keep ? `Rollback incomplete: ${rollback.join('; ')}. Recovery copies: ${recovery}` : 'Rolled back all writes.'}`)
				}
				return changed.map((p) => `== ${p.path}${p.next === null ? ' deleted' : `@${fileText.hash(p.next)}`} verified ==${String.fromCharCode(10)}${p.diff}`).join(String.fromCharCode(10))
			})()
		} catch (e) {
			failure = e
		}
		const cleanup: string[] = []
		try {
			if (recovery && !keep) await rm(recovery, { recursive: true })
		} catch (e: any) {
			cleanup.push(`recovery ${recovery}: ${e.message}`)
		}
		try {
			await fileChanges.finish(observation)
		} catch (e: any) {
			cleanup.push(e.message)
		}
		if (cleanup.length) throw new Error(`${failure ?? 'Writes verified'}; cleanup: ${cleanup.join('; ')}`)
		if (failure) throw failure
		let out = result!
		const then = Array.isArray(input.then) ? input.then as string[] : []
		for (const [k, text] of then.entries()) {
			const r = nativeTool.resolve(text, ctx)
			const res = await tools.run({
				type: 'tool_call',
				id: `${ctx.callId ?? 'edit'}-then${k + 1}`,
				name: r.name,
				input: r.input
			} as any, ctx)
			out += `${N}== then ${text.trim().split(N)[0]!.slice(0, 160)} ==${N}${res.output}`
			if (res.isError && k + 1 < then.length) {
				out += `${N}The ${then.length - k - 1} call(s) after it did not run.`;
				break
			}
		}
		return out
	},
}
