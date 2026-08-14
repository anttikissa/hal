import { homedir } from 'os'
import { resolve } from 'path'

function shellPath(text: string, cwd: string): string {
	let path = text.replace(/^['"]|['"]$/g, '')
	const home = homedir()
	if (path === '~') path = home
	if (path.startsWith('~/')) path = home + path.slice(1)
	return resolve(cwd, path)
}

function stripCdCwd(command: string | undefined, cwd: string): string | undefined {
	const match = command?.match(/^cd\s+(.+?)\s*&&\s*/)
	if (!match) return command
	const target = shellCommand.shellPath(match[1]!, cwd)
	return target === resolve(cwd) ? command!.slice(match[0].length) : command
}

export const shellCommand = { shellPath, stripCdCwd }
