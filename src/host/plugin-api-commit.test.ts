// Keeps API version recording honest across real Git commits, failures and partial staging.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from '../common/ason.ts'

let dir = ''
let root = resolve(import.meta.dir, '../..')

function git(...args: string[]) {
	let result = Bun.spawnSync(
		['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
		{ cwd: dir },
	)
	return { code: result.exitCode, text: result.stdout.toString(), error: result.stderr.toString() }
}

function ok(...args: string[]) {
	let result = git(...args)
	if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.error}`)
	return result.text
}

function prepare(message: string, paths: string[] = []) {
	let head = ok('rev-parse', 'HEAD')
	let result = git('commit', '-qm', message, ...paths)
	expect(result.code).not.toBe(0)
	expect(result.error).toContain('Commit stopped: Git built its tree before this hook.')
	expect(ok('rev-parse', 'HEAD')).toBe(head)
}

function write(path: string, text: string) {
	writeFileSync(join(dir, path), text)
}

function current() {
	return parse(ok('show', 'HEAD:plugin-api.ason')) as any
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'hal-plugin-api-'))
	ok('init', '-q', '-b', 'main')
	ok('config', 'core.hooksPath', join(root, 'scripts/hooks'))
	symlinkSync(join(root, 'scripts'), join(dir, 'scripts'))
	write('plugin-api.ason', '{ version: 1, changes: [] }\n')
	write('file.ts', 'export const a = 1\n')
	ok('add', '--', 'plugin-api.ason', 'file.ts')
	ok('commit', '-qm', 'Baseline\n\nPlugin-API: none')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('none preserves the version; mixed API changes produce one persisted version', () => {
	write('file.ts', 'export const a = 2\n')
	ok('add', '--', 'file.ts')
	ok('commit', '-qm', 'Refactor\n\nPlugin-API: none')
	expect(current().version).toBe(1)
	write('file.ts', 'export const b = 2\n')
	ok('add', '--', 'file.ts')
	let message = `Change APIs

Plugin-API: rename common/example.a -> common/example.b
Plugin-API: compatible host/items.Item | Adds optional label
Plugin-API: breaking host/items.save | Completes before persistence
  | Await the returned done promise`
	prepare(message)
	ok('commit', '-qm', message)
	expect(current()).toEqual({
		version: 2,
		changes: [
			{
				version: 2,
				changes: [
					{ kind: 'rename', from: 'common/example.a', to: 'common/example.b' },
					{ kind: 'compatible', target: 'host/items.Item', description: 'Adds optional label' },
					{
						kind: 'breaking',
						target: 'host/items.save',
						description: 'Completes before persistence',
						port: 'Await the returned done promise',
					},
				],
			},
		],
	})
	expect(ok('status', '--porcelain', '--untracked-files=no')).toBe('')
	ok('commit', '--amend', '--no-edit', '-q')
	expect(current().version).toBe(2)
})

test('a commit without a declaration succeeds as none, so users can always commit', () => {
	write('file.ts', 'export const c = 1\n')
	ok('add', '--', 'file.ts')
	ok('commit', '-qm', 'User commit')
	expect(current().version).toBe(1)
})

test('mixed, duplicate and incomplete declarations fail without changing the index', () => {
	write('file.ts', 'export const b = 1\n')
	ok('add', '--', 'file.ts')
	let index = ok('write-tree')
	for (let declaration of [
		'Plugin-API: none\nPlugin-API: rename a -> b',
		'Plugin-API: breaking a | Changed behavior',
		'Plugin-API: rename a -> a',
		'Plugin-API: rename a -> b\nPlugin-API: breaking a | Changed | Port it',
	]) {
		let result = git('commit', '-qm', `Invalid\n\n${declaration}`)
		expect(result.code).not.toBe(0)
		expect(result.error.length).toBeGreaterThan(0)
		expect(ok('write-tree')).toBe(index)
	}
	expect(current().version).toBe(1)
})

test('a failed commit can retry without incrementing again or staging unrelated work', () => {
	write('file.ts', 'export const b = 1\n')
	ok('add', '--', 'file.ts')
	write('file.ts', 'export const unstaged = 9\n')
	write('unrelated.txt', 'leave this alone\n')
	let message = 'Rename\n\nPlugin-API: rename common/example.a -> common/example.b'
	prepare(message)
	let staged = ok('show', ':plugin-api.ason')
	ok('commit', '-qm', message)
	expect(ok('show', 'HEAD:plugin-api.ason')).toBe(staged)
	expect(current().version).toBe(2)
	expect(ok('show', 'HEAD:file.ts')).toBe('export const b = 1\n')
	expect(readFileSync(join(dir, 'file.ts'), 'utf8')).toBe('export const unstaged = 9\n')
	expect(git('show', 'HEAD:unrelated.txt').code).not.toBe(0)
})

test('unstaged ledger edits and rewritten history are preserved and rejected', () => {
	write('file.ts', 'export const b = 1\n')
	ok('add', '--', 'file.ts')
	let privateEdit = '{ version: 1, changes: [] } // keep my edit\n'
	write('plugin-api.ason', privateEdit)
	let message = 'Rename\n\nPlugin-API: rename common/example.a -> common/example.b'
	let result = git('commit', '-qm', message)
	expect(result.code).not.toBe(0)
	expect(result.error).toContain('unstaged changes')
	expect(readFileSync(join(dir, 'plugin-api.ason'), 'utf8')).toBe(privateEdit)
	write('plugin-api.ason', '{ version: 1, changes: [] }\n')
	prepare(message)
	ok('commit', '-qm', message)
	write('plugin-api.ason', '{ version: 1, changes: [] }\n')
	ok('add', '--', 'plugin-api.ason')
	result = git('commit', '-qm', 'Erase history\n\nPlugin-API: none')
	expect(result.code).not.toBe(0)
	expect(result.error).toContain('staged history differs')
	expect(current().version).toBe(2)
})

test('path-only commits include the generated ledger but not separately staged files', () => {
	write('file.ts', 'export const b = 1\n')
	write('other.txt', 'staged for another commit\n')
	ok('add', '--', 'other.txt')
	let message = 'Rename\n\nPlugin-API: rename common/example.a -> common/example.b'
	prepare(message, ['--', 'file.ts'])
	ok('commit', '-qm', message, '--', 'file.ts', 'plugin-api.ason')
	expect(current().version).toBe(2)
	expect(git('show', 'HEAD:other.txt').code).not.toBe(0)
	expect(ok('diff', '--cached', '--name-only').trim()).toBe('other.txt')
})
