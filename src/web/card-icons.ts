// The icon a folded card's header names its kind with (Card.tsx), and
// titles without the leading mark or tool name the icon replaces.

import type { Item } from '../common/transcript.ts'
import { titles } from '../common/titles.ts'
import { icons, type IconName } from './icons.ts'

// Tool cards' header icons, by tool name.
const toolIcons: Record<string, IconName> = {
	read: 'read',
	edit: 'scissors',
	google: 'google',
	send: 'message',
	wait: 'wait',
	command: 'command',
	inspect: 'inspect',
	ask: 'ask',
	read_blob: 'blob',
	read_entry: 'blob',
	help: 'inspect',
}

// Folded cards name their kind with an icon: thinking, another
// session's message or command (the send tool's bubble, which
// unfolded ones show too), or the tool. Bash shows the terminal's
// `$ ` as copyable text instead (task ya1).
function kind(item: Item): IconName | undefined {
	if (item.type === 'thinking') return 'thinking'
	if (titles.letter(item) === 'm') return 'message'
	if (item.type !== 'tool') return undefined
	let named = item.presentation?.icon
	return cardIcons.toolIcons[item.name] ?? (named === undefined ? undefined : icons.has(named) ? named : 'sparkle')
}

// A title without what its icon, or bash's `$ `, shows instead: a
// message's <= or =>, or the tool's name.
function unmark<T extends string | undefined>(title: T, tool?: string): T {
	if (tool && (cardIcons.toolIcons[tool] || tool === 'bash') && title?.startsWith(`${tool} `))
		return title.slice(tool.length + 1) as T
	return title?.replace(/^(?:<=|=>) /, '') as T
}

export const cardIcons = { toolIcons, kind, unmark }
