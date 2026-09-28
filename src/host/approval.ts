// Approval for dangerous tool calls (tasks/w4/forms.md, Approval).
// Before a round's tool calls run, each bash command is checked against
// patterns for commands that destroy work: rm -rf, git reset --hard and
// friends. Not plain rm -f, which models overuse and which is rarely
// dangerous. A match asks the human y/N (default No), durably, showing
// the command with the offending parts marked; No gives the model an
// error result instead of running it.
//
// Best effort by name (setting `security`): there is no sandbox, and a
// determined model gets around patterns. It catches mistakes.

import { resolve } from 'path'
import type { ToolCallBlock } from '../common/blocks.ts'
import type { Form } from '../common/forms.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { settings } from '../common/settings.ts'

type Mark = [number, number]

// Where each shell segment (split at ; & | and newlines) starts and ends.
function segments(command: string): Mark[] {
	let out: Mark[] = []
	let start = 0
	for (let m of command.matchAll(/[\n;&|]+/g)) {
		out.push([start, m.index])
		start = m.index + m[0].length
	}
	out.push([start, command.length])
	return out
}

// Assignments like D=/tmp/x or D=$(mktemp -d), so rm -rf $D is known safe.
function tmpVars(command: string): Map<string, string> {
	let vars = new Map<string, string>()
	for (let m of command.matchAll(/(?:^|[\s;])([A-Za-z_]\w*)=(?:(\/tmp\/[^\s;&|]+)|\$\(mktemp -d\))/g)) vars.set(m[1]!, m[2] ?? '/tmp/mktemp')
	return vars
}

// A removal inside /tmp (not /tmp itself): scratch space models clean
// up. `dir`: where the command runs, if cd made it known (a relative
// target resolves against it).
function safeTmp(token: string, vars: Map<string, string>, dir?: string): boolean {
	let t = token.replace(/^['"]|['"]$/g, '')
	let v = t.match(/^\$\{?([A-Za-z_]\w*)\}?$/)
	if (v && vars.has(v[1]!)) t = vars.get(v[1]!)!
	if (t.includes('..') || /[$`~\\]/.test(t)) return false
	if (!t.startsWith('/')) {
		if (!dir) return false
		t = resolve(dir, t)
	}
	if (!t.startsWith('/tmp/') || t === '/tmp/' || t === '/tmp/*') return false
	return resolve('/', t).startsWith('/tmp/')
}

// Where `cd <arg>` goes from `dir`, or undefined if that can't be told:
// no argument (home), ~, variables other than a known /tmp one, .., options.
function cdTarget(arg: string | undefined, dir: string | undefined, vars: Map<string, string>): string | undefined {
	if (!arg) return undefined
	let t = arg.replace(/^['"]|['"]$/g, '')
	if (t === '$(mktemp -d)') return '/tmp/mktemp'
	let v = t.match(/^\$\{?([A-Za-z_]\w*)\}?$/)
	if (v) return vars.get(v[1]!)
	if (t.includes('..') || t.startsWith('-') || /[$`~*?\\]/.test(t)) return undefined
	return t.startsWith('/') ? resolve(t) : dir && resolve(dir, t)
}

// The directory each segment runs in, as far as cd shows it (undefined
// when unknown, as at the start). A cd carries over && only, since after
// ; or || the next command also runs when cd failed; a `cd /tmp` that
// surely ran (not itself after &&) cannot fail, so it carries over ;
// and newlines too. Pipes, background jobs and any other directory
// change (a cd inside braces or if, pushd, eval, source) make it unknown.
function dirs(command: string, segs: Mark[], vars: Map<string, string>): (string | undefined)[] {
	let out: (string | undefined)[] = []
	let dir: string | undefined
	let sure = false
	for (let i = 0; i < segs.length; i++) {
		let [from, to] = segs[i]!
		let sep = i ? command.slice(segs[i - 1]![1], from).replace(/\n/g, '') : ''
		if (sep !== '&&' && !((sep === ';' || sep === '') && sure)) dir = undefined
		out.push(dir)
		let seg = command.slice(from, to)
		let cd = seg.match(/^\s*cd(?:\s+("?\$\(mktemp -d\)"?|\S+))?\s*$/)
		if (cd) {
			dir = cdTarget(cd[1], dir, vars)
			sure = dir === '/tmp' && cd[1]!.replace(/^['"]|['"]$/g, '').startsWith('/') && sep !== '&&'
		} else if (/(^|[\s({`$])(cd|pushd|popd|source|eval)(\s|$)|(^|[\s({])\.\s/.test(seg)) dir = undefined
		if (!dir) sure = false
	}
	return out
}

const git: RegExp[] = [
	/\bgit\s+reset\s+--hard\b.*/,
	/\bgit\s+clean\b.*\s-[a-z]*[fxd].*/,
	/\bgit\s+stash\s+(drop|clear)\b.*/,
	/\bgit\s+push\b.*\s(--force(-with-lease)?|-f)\b.*/,
	/\bgit\s+(checkout|restore)\b(?=.*\s--\s+\S|.*\s(\.|(?!v\d)\S+\.[A-Za-z0-9]+)(\s|$)).*/,
]

// The offending parts of a shell command, as [start, end) offsets.
function marks(command: string): Mark[] {
	let out: Mark[] = []
	let vars = approval.tmpVars(command)
	let segs = approval.segments(command)
	let where = approval.dirs(command, segs, vars)
	for (let [i, [from, to]] of segs.entries()) {
		let seg = command.slice(from, to)
		let found: RegExpMatchArray | null = null
		let rm = seg.match(/\brm\s+(.*)/)
		if (rm) {
			let tokens = rm[1]!.trim().split(/\s+/)
			let flags = tokens.filter((t) => t.startsWith('-'))
			let recursive = flags.some((f) => f === '--recursive' || /^-[a-zA-Z]*[rR]/.test(f))
			let force = flags.some((f) => f === '--force' || /^-[a-zA-Z]*f/.test(f))
			let targets = tokens.filter((t) => !t.startsWith('-'))
			if (recursive && force && (!targets.length || targets.some((t) => !approval.safeTmp(t, vars, where[i])))) found = rm
		}
		for (let re of git) found ??= seg.match(re)
		if (!found) continue
		let text = found[0].trimEnd()
		out.push([from + found.index!, from + found.index! + text.length])
	}
	return out
}

// The question for a call that needs approval, or undefined if it may
// run without asking.
function form(call: ToolCallBlock): Form | undefined {
	if (settings.security() === 'none' || call.name !== 'bash' || typeof call.input.command !== 'string') return undefined
	let command = call.input.command
	let found = approval.marks(command)
	if (!found.length) return undefined
	return {
		text: 'Run this command? It matches a dangerous pattern.',
		quote: { text: command, marks: found },
		fields: [{ type: 'choice', name: 'run', options: ['yes', 'no'], initial: 1 }],
	}
}

// The result the model gets for a call the human said no to.
function declined(call: ToolCallBlock) {
	return { type: 'tool_result' as const, id: call.id, output: 'The user declined to run this; it did not run.', isError: true }
}

// The last round's calls, if they are held for approval and none has
// run: at least one was asked about, nothing answered them, and no host
// continued the turn after every question was answered (then they may
// have run). `decided`: call id → yes, from the answers so far.
function held(records: HistoryRecord[]): { calls: ToolCallBlock[]; decided: Map<string, boolean> } | undefined {
	let end = records.findLastIndex((r) => r.type === 'assistant')
	let start = end
	while (start > 0 && records[start - 1]!.type === 'assistant') start--
	let calls = records.slice(start, end + 1).flatMap((r) => (r.type === 'assistant' && r.block.type === 'tool_call' ? [r.block] : []))
	if (!calls.length) return undefined
	let ids = new Set(calls.map((c) => c.id))
	let decided = new Map<string, boolean>()
	let asked: Extract<HistoryRecord, { type: 'question' }> | undefined
	let open = false
	for (let r of records.slice(end + 1)) {
		if (r.type === 'user') return undefined
		if (r.type === 'question' && r.call !== undefined && ids.has(r.call)) {
			asked = r
			open = true
		} else if (r.type === 'answer' && r.question === asked?.id) {
			open = false
			decided.set(asked.call!, r.answers.run === 'yes')
		} else if (r.type === 'continue' && !open) return undefined
	}
	return asked ? { calls, decided } : undefined
}

export const approval = { segments, tmpVars, safeTmp, cdTarget, dirs, marks, form, declined, held }
