// File-oriented plugins share transform and observation points without imposing scope.
import { isAbsolute, relative, resolve } from 'path'
import type { FileChange } from '../common/replay.ts'
import type { ToolContext } from './tools.ts'

// Paths are lexical; callers can use fileChanges.canonical when symlinks matter.
function within(root: string, path: string): boolean {
	let name = relative(resolve(root), resolve(path))
	return name !== '..' && !name.startsWith('../') && !isAbsolute(name)
}

async function transform(_path: string, text: string, _ctx: ToolContext): Promise<string> {
	return text
}

async function changed(_files: FileChange[], _ctx: ToolContext): Promise<void> {}

export const pluginFiles = { within, transform, changed }
