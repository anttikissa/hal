// The icon a folded card's header names its kind with (Card.tsx), and
// titles without the leading mark the icon replaces.

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
	notify: 'notify',
	ask: 'ask',
	read_blob: 'blob',
	read_entry: 'blob',
	stop: 'stop',
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

// A title without its leading mark ($, <, =>, …): the icon shows it.
function unmark<T extends string | undefined>(title: T): T {
	return title?.replace(/^(?:<=|=>|[$<>…!x?]) /, '') as T
}

export const cardIcons = { toolIcons, kind, unmark }
