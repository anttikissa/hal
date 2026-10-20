// Approval for dangerous tool calls (tasks/w4/forms.md, Approval).
// Before a round's tool calls run, each bash command is checked against
// patterns for commands that destroy work or print secrets: rm -rf,
// git reset --hard, cat sensitive paths, ps -E and friends. Plain rm -f
// is rarely dangerous. A match asks the human y/N (default No), durably,
// with each match's reason and the command with the offending parts
// marked; No gives the model an error result instead of running it.
//
// Best effort by name (setting `security`): there is no sandbox, and a
// determined attacker gets around patterns. It catches mistakes.

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

const mktemp = '/tmp/mktemp'

// Assignments like D=/tmp/x or D=$(mktemp -d [template]), so rm -rf $D
// is known safe. Any other assignment to the name forgets it.
function tmpVars(command: string): Map<string, string> {
	let vars = new Map<string, string>()
	for (let m of command.matchAll(
		/(?:^|[\s;])([A-Za-z_]\w*)=(?:(\/tmp\/[^\s;&|]+)|(\$\(mktemp -d(?:\s+[^\s)$`;&|]+)*\))|)/g,
	)) {
		if (m[2] || m[3]) vars.set(m[1]!, m[2] ?? mktemp)
		else vars.delete(m[1]!)
	}
	return vars
}

// A removal inside /tmp (not /tmp itself): scratch space models clean
// up. `dir`: where the command runs, if cd made it known (a relative
// target resolves against it). $D/x needs D set to a literal path: a
// failed mktemp leaves D empty, making it /x.
function safeTmp(token: string, vars: Map<string, string>, dir?: string): boolean {
	let t = token.replace(/^['"]|['"]$/g, '')
	let v = t.match(/^\$\{?([A-Za-z_]\w*)\}?(\/.*)?$/)
	let value = v && vars.get(v[1]!)
	if (value && !(v![2] && value === mktemp)) t = value + (v![2] ?? '')
	if (t.includes('..') || /[$`~\\]/.test(t)) return false
	if (!t.startsWith('/')) {
		if (!dir) return false
		t = resolve(dir, t)
	}
	let r = resolve('/', t)
	return r.startsWith('/tmp/') && r !== '/tmp/*'
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

const reasons = {
	rm: 'May wipe out important files by accident.',
	print: 'Will likely leak your secrets.',
	env: 'Reveals env variables. If you have secrets like OPENAI_API_KEY in env, this will leak them.',
}

const git: [RegExp, string][] = [
	[/\bgit\s+reset\s+--hard\b.*/, 'Throws away uncommitted changes.'],
	[/\bgit\s+clean\b.*\s-[a-z]*[fxd].*/, 'Wipes out untracked files for good.'],
	[/\bgit\s+stash\s+(drop|clear)\b.*/, 'Throws away stashed changes.'],
	[/\bgit\s+push\b.*\s(--force(-with-lease)?|-f)\b.*/, "May clobber others' commits on the remote."],
	[
		/\bgit\s+(checkout|restore)\b(?=.*\s--\s+\S|.*\s(\.|(?!v\d)\S+\.[A-Za-z0-9]+)(\s|$)).*/,
		'Throws away uncommitted changes in these files.',
	],
]

// A command that starts the segment, like `cat x` but not `echo "cat x"`.
function leading(seg: string, re: RegExp): RegExpMatchArray | null {
	let m = seg.match(re)
	return m && !seg.slice(0, m.index).trim() ? m : null
}

// ps -E (macOS) or ps e (BSD-style options, first argument) prints
// every process's environment; so does /proc/<pid>/environ.
function envDump(seg: string): RegExpMatchArray | null {
	let ps = leading(seg, /(?<!\S)(?:\/bin\/)?ps(?:\s+(.*)|$)/)
	let args = ps?.[1]?.trim().split(/\s+/) ?? []
	if (ps && (args.some((a) => /^-[a-zA-Z]*E/.test(a)) || /^[a-zA-Z]*e[a-zA-Z]*$/.test(args[0] ?? ''))) return ps
	return seg.match(/\S*\/proc\/[^\s/]+\/environ\S*/)
}

// The offending parts of a shell command, as [start, end) offsets, each
// with why it is dangerous.
function findings(command: string): { at: Mark; reason: string }[] {
	let out: { at: Mark; reason: string }[] = []
	let vars = approval.tmpVars(command)
	let segs = approval.segments(command)
	let where = approval.dirs(command, segs, vars)
	for (let [i, [from, to]] of segs.entries()) {
		let seg = command.slice(from, to)
		let found: RegExpMatchArray | null = null
		let reason = ''
		let rm = seg.match(/\brm\s+(.*)/)
		if (rm) {
			let tokens = rm[1]!.trim().split(/\s+/)
			let flags = tokens.filter((t) => t.startsWith('-'))
			let recursive = flags.some((f) => f === '--recursive' || /^-[a-zA-Z]*[rR]/.test(f))
			let force = flags.some((f) => f === '--force' || /^-[a-zA-Z]*f/.test(f))
			let targets = tokens.filter((t) => !t.startsWith('-'))
			if (recursive && force && (!targets.length || targets.some((t) => !approval.safeTmp(t, vars, where[i])))) {
				found = rm
				reason = reasons.rm
			}
		}
		for (let [re, why] of git) if (!found && (found = seg.match(re))) reason = why
		if (!found && (found = envDump(seg))) reason = reasons.env
		let print = leading(seg, /(?<!\S)(?:\/(?:usr\/)?bin\/)?(?:cat|head|tail)\s+(.*)/)
		if (
			!found &&
			print &&
			(print[1]!.match(/"[^"]*"|'[^']*'|[^\s<>]+/g) ?? []).some((t) =>
				approval.sensitive(t.replace(/^['"]|['"]$/g, '')),
			)
		) {
			found = print
			reason = reasons.print
		}
		if (!found) continue
		let text = found[0].trimEnd()
		out.push({ at: [from + found.index!, from + found.index! + text.length], reason })
	}
	return out
}

// The question for a call that needs approval, or undefined if it may
// run without asking.
function form(call: ToolCallBlock): Form | undefined {
	if (settings.security() === 'none' || call.name !== 'bash' || typeof call.input.command !== 'string') return undefined
	let command = call.input.command
	let found = approval.findings(command)
	if (!found.length) return undefined
	return {
		text: [...new Set(found.map((f) => f.reason)), '/help security to learn more.'].join('\n'),
		quote: { text: command, marks: found.map((f) => f.at) },
		fields: [{ type: 'choice', name: 'run', options: ['yes', 'no'], initial: 1 }],
	}
}

// The result the model gets for a call the human said no to.
function declined(call: ToolCallBlock) {
	return {
		type: 'tool_result' as const,
		id: call.id,
		output: 'The user declined to run this; it did not run.',
		isError: true,
	}
}

// The last round's calls, if they are held for approval and none has
// run: at least one was asked about, nothing answered them, and no host
// continued the turn after every question was answered (then they may
// have run). `decided`: call id → yes, from the answers so far.
function held(records: HistoryRecord[]): { calls: ToolCallBlock[]; decided: Map<string, boolean> } | undefined {
	let end = records.findLastIndex((r) => r.type === 'assistant')
	let start = end
	while (start > 0 && records[start - 1]!.type === 'assistant') start--
	let calls = records
		.slice(start, end + 1)
		.flatMap((r) => (r.type === 'assistant' && r.block.type === 'tool_call' ? [r.block] : []))
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

// Shared best-effort sensitive-path policy for READ, shell approval and
// snapshots. Public keys (*.pub) are meant to be shared, even in .ssh/.
function sensitive(path: string): boolean {
	if (/\.pub$/i.test(path)) return false
	const secretPaths =
		/(?:^|\/)(?:\.env(?:\.[^/]*)?|\.ssh|\.aws|\.gnupg|secrets|credentials(?:\.[^/]*)?|auth\.ason|id_(?:rsa|dsa|ecdsa|ed25519))(?:\/|$)/i
	const processEnv = /(?:^|\/)proc\/[^/]+\/environ$/
	const privateKeyFiles = /\.(?:pem|key|p12|pfx)$/i
	const cryptoWalletFiles =
		/(?:^|\/)(?:wallet\.dat(?:-(?:journal|wal|shm))?|UTC--[^/]+|[^/]+\.keys|exodus\.wallet|nkbihfbeogaeaoehlefnkodbefgpgknn)(?:\/|$)/i
	const cryptoWalletPaths =
		/(?:^|\/)(?:(?:\.?electrum|\.electron-cash|electron cash|\.?sparrow)\/(?:[^/]+\/)*wallets|\.?walletwasabi\/client\/wallets|\.config\/solana\/id\.json)(?:\/|$)/i
	return (
		secretPaths.test(path) ||
		processEnv.test(path) ||
		privateKeyFiles.test(path) ||
		cryptoWalletFiles.test(path) ||
		cryptoWalletPaths.test(path)
	)
}

export const approval = { segments, tmpVars, safeTmp, cdTarget, dirs, findings, form, declined, held, sensitive }
