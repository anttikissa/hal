// Sensitive file guardrails for tools.
//
// These protect secrets from being copied into model-visible tool results. They
// are intentionally scoped to tool access: auth.ts may still read auth.ason for
// provider credentials, but read/grep/glob/bash/eval/write/edit should not expose
// or modify it by accident.

import { existsSync } from 'fs'
import { basename, resolve } from 'path'
import { HAL_DIR } from '../state.ts'

const config = {
	protectedBasenames: ['auth.ason'],
}

function normalized(path: string): string {
	return resolve(path)
}

function protectedPaths(): string[] {
	const paths: string[] = []
	for (const name of config.protectedBasenames) paths.push(resolve(HAL_DIR, name))
	return paths
}

function isProtectedPath(path: string): boolean {
	const target = normalized(path)
	for (const protectedPath of protectedPaths()) {
		if (target === protectedPath) return true
	}
	return false
}

function isProtectedBasename(path: string): boolean {
	return config.protectedBasenames.includes(basename(path))
}

function denyMessage(action: string, path: string): string {
	return `error: refusing to ${action} protected credentials file: ${path}`
}

function denyIfProtected(path: string, action: string): string | null {
	if (!isProtectedPath(path)) return null
	return denyMessage(action, path)
}

function filterPathList(text: string): string {
	const kept: string[] = []
	let hidden = 0
	for (const line of text.split('\n')) {
		if (!line) continue
		const firstField = line.split(':', 1)[0] ?? line
		if (isProtectedPath(firstField) || isProtectedBasename(firstField)) {
			hidden++
			continue
		}
		kept.push(line)
	}
	if (hidden > 0) kept.push(`[${hidden} protected credential file${hidden === 1 ? '' : 's'} hidden]`)
	return kept.join('\n')
}

function shellProfile(): string | null {
	const paths = protectedPaths().filter((path) => existsSync(path))
	if (paths.length === 0) return null

	const lines = ['(version 1)', '(allow default)']
	for (const path of paths) {
		// sandbox-exec literals are not shell-quoted; escape for the SBPL string.
		const escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
		lines.push(`(deny file-read* (literal "${escaped}"))`)
		lines.push(`(deny file-write* (literal "${escaped}"))`)
	}
	return lines.join('\n')
}

function commandMentionsProtectedPath(command: string): boolean {
	const lower = command.toLowerCase()
	for (const path of protectedPaths()) {
		if (lower.includes(path.toLowerCase())) return true
	}
	for (const name of config.protectedBasenames) {
		if (lower.includes(name.toLowerCase())) return true
	}
	return false
}

function evalMentionsProtectedAccess(code: string): boolean {
	const lower = code.toLowerCase()
	if (commandMentionsProtectedPath(code)) return true
	if (lower.includes('/src/auth.ts') || lower.includes('~/auth.ts') || lower.includes('../auth.ts')) return true
	if (lower.includes('auth.getcredential') || lower.includes('auth.listcredentials') || lower.includes('auth.getentry')) return true
	return false
}

export const sensitive = {
	config,
	protectedPaths,
	isProtectedPath,
	isProtectedBasename,
	denyMessage,
	denyIfProtected,
	filterPathList,
	shellProfile,
	commandMentionsProtectedPath,
	evalMentionsProtectedAccess,
}
