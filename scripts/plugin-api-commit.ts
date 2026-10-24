// Records declared API changes from a commit message without guessing compatibility.
import { strict as assert } from 'node:assert'
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from '../src/common/ason.ts'

type Change =
	| { kind: 'rename'; from: string; to: string }
	| { kind: 'compatible'; target: string; description: string }
	| { kind: 'breaking'; target: string; description: string; port: string }
type Ledger = { version: number; changes: { version: number; changes: Change[] }[] }

const ledgerPath = 'plugin-api.ason'
const usage = `Declare API changes in the commit message (repeat Plugin-API for multiple changes):
  Plugin-API: none
  Plugin-API: rename host/tools.all -> host/tools.list
  Plugin-API: compatible host/tools.Tool | Adds optional field label
  Plugin-API: breaking host/files.write | Returns before completion | Await result.done
Use indented continuation lines for long descriptions. Classify behavior yourself;
the hook records your declaration, not a compatibility guess.
See tasks/q03/api-version.md.`

function declaration(message: string): Change[] {
	let lines = message.split(/\r?\n/),
		entries: string[] = []
	for (let i = 0; i < lines.length; i++) {
		let match = /^Plugin-API:\s*(.*)$/i.exec(lines[i]!)
		if (!match) continue
		let value = match[1]!.trim()
		while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1]!)) value += ` ${lines[++i]!.trim()}`
		entries.push(value)
	}
	// No declaration means none: users commit freely; agents declare changes (AGENTS.md).
	if (!entries.length || (entries.length === 1 && entries[0] === 'none')) return []
	assert(!entries.includes('none'), 'Plugin-API: none cannot accompany API changes.')
	let changes = entries.map((entry): Change => {
		let rename = /^rename\s+(\S+)\s+->\s+(\S+)$/.exec(entry)
		if (rename) {
			assert(rename[1] !== rename[2], `Rename has identical targets: ${entry}`)
			return { kind: 'rename', from: rename[1]!, to: rename[2]! }
		}
		let change = /^(compatible|breaking)\s+(\S+)\s*\|\s*(.+)$/.exec(entry)
		if (change) {
			let parts = change[3]!.split('|').map((p) => p.trim())
			if (change[1] === 'compatible' && parts.length === 1 && parts[0])
				return { kind: 'compatible', target: change[2]!, description: parts[0] }
			if (change[1] === 'breaking' && parts.length === 2 && parts[0] && parts[1])
				return { kind: 'breaking', target: change[2]!, description: parts[0], port: parts[1] }
		}
		throw new Error(`Invalid Plugin-API declaration: ${entry}\n${usage}`)
	})
	let targets = changes.map((c) => (c.kind === 'rename' ? c.from : c.target))
	assert(new Set(targets).size === targets.length, 'Declare each API target once per commit.')
	return changes
}

function ledger(text: string): Ledger {
	let data = parse(text) as Ledger
	assert(data && Number.isSafeInteger(data.version) && data.version >= 1, `${ledgerPath}: invalid version`)
	assert(Array.isArray(data.changes) && data.changes.length === data.version - 1, `${ledgerPath}: invalid history`)
	for (let [i, entry] of data.changes.entries()) {
		assert(
			entry.version === i + 2 && Array.isArray(entry.changes) && entry.changes.length,
			`${ledgerPath}: invalid entry`,
		)
		for (let change of entry.changes) {
			assert(change && typeof change === 'object', `${ledgerPath}: invalid change`)
			let fields =
				change.kind === 'rename'
					? ['from', 'to']
					: change.kind === 'compatible'
						? ['target', 'description']
						: change.kind === 'breaking'
							? ['target', 'description', 'port']
							: []
			assert(fields.length, `${ledgerPath}: unknown change kind`)
			for (let field of fields) {
				let value = (change as any)[field]
				assert(typeof value === 'string' && value.trim(), `${ledgerPath}: missing ${field}`)
			}
		}
	}
	return data
}

function git(...args: string[]): string {
	let result = Bun.spawnSync(['git', ...args])
	assert(result.exitCode === 0, `git ${args.join(' ')} failed (${result.exitCode}):\n${result.stderr.toString()}`)
	return result.stdout.toString()
}

function run(messageFile: string): void {
	let changes = declaration(readFileSync(messageFile, 'utf8'))
	let root = git('rev-parse', '--show-toplevel').trim()
	process.chdir(root)
	let head = git('rev-parse', '--revs-only', 'HEAD')
	let baseText =
		head && git('ls-tree', '--name-only', 'HEAD', '--', ledgerPath).trim()
			? git('show', `HEAD:${ledgerPath}`)
			: '{ version: 1, changes: [] }'
	let base = ledger(baseText)
	let indexed = git('ls-files', '--stage', '--', ledgerPath)
	assert(
		/^100644 [0-9a-f]+ 0\tplugin-api\.ason\n$/.test(indexed),
		`Stage ${ledgerPath} as a regular file before committing.`,
	)
	let stagedText = git('show', `:${ledgerPath}`)
	let staged = ledger(stagedText)
	let same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
	// A message-only amend retains the declaration of the existing commit.
	if (
		same(base, staged) &&
		same(changes, base.changes.at(-1)?.changes) &&
		!git('diff', '--cached', '--name-only').trim()
	)
		return
	let next: Ledger = changes.length
		? { version: base.version + 1, changes: [...base.changes, { version: base.version + 1, changes }] }
		: base
	assert(
		same(staged, base) || same(staged, next),
		`${ledgerPath}: staged history differs from HEAD and this declaration. Preserve committed history; resolve the pending entry before retrying.`,
	)
	if (!changes.length || same(staged, next)) return
	let path = join(root, ledgerPath)
	assert(
		lstatSync(path).isFile() && readFileSync(path, 'utf8') === stagedText,
		`${ledgerPath}: unstaged changes; the hook will not overwrite them. Stage or move them before retrying.`,
	)
	assert(git('rev-parse', '--revs-only', 'HEAD') === head, 'HEAD changed during the API check; retry the commit.')
	let text = `${stringify(next)}\n`
	let temp = `${path}.${process.pid}.tmp`
	writeFileSync(temp, text, { flag: 'wx' })
	renameSync(temp, path)
	git('add', '--', ledgerPath)
	throw new Error(
		`Plugin API version ${next.version} prepared in ${ledgerPath}.\n` +
			`Commit stopped: Git built its tree before this hook. Review the ledger and repeat the commit.\n` +
			`If committing explicit paths, include ${ledgerPath}.`,
	)
}

export const pluginApiCommit = { declaration, ledger, run }

if (import.meta.main) {
	try {
		assert(process.argv.length === 3, 'Usage: bun scripts/plugin-api-commit.ts <commit-message-file>')
		pluginApiCommit.run(process.argv[2]!)
	} catch (error) {
		console.error(error instanceof Error ? error.message : error)
		process.exitCode = 1
	}
}
