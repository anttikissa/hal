// Shell-tool error rubric: scans the most recent BASH calls in Hal session
// histories and tabulates errors that shell tools printed (wrong options,
// bad expressions, missing commands, missing files), plus this host's tool
// dialects (GNU vs BSD). Read-only.
//
// Usage: bun shell-errors.ts <hal-checkout> [sessions-dir] [count=5000] [--examples]
//   hal-checkout: for its ASON parser; sessions-dir defaults to <hal-checkout>/sessions
// Review the output before sharing: example messages can contain paths.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2).filter((a) => a !== '--examples')
const examples = process.argv.includes('--examples')
const hal = args[0]
if (!hal) throw new Error('usage: bun shell-errors.ts <hal-checkout> [sessions-dir] [count] [--examples]')
const dir = args[1] ?? join(hal, 'sessions')
const count = Number(args[2] ?? 5000)
const { parse } = await import(join(hal, 'src/common/ason.ts'))

const TOOLS = [
	'grep',
	'egrep',
	'sed',
	'awk',
	'gawk',
	'mawk',
	'find',
	'xargs',
	'timeout',
	'date',
	'stat',
	'tar',
	'rg',
	'fd',
	'jq',
	'sort',
	'cut',
	'head',
	'tail',
	'wc',
	'ls',
	'cp',
	'mv',
	'rm',
	'mkdir',
	'readlink',
	'realpath',
	'du',
	'df',
	'ps',
	'pkill',
	'pgrep',
	'kill',
	'curl',
	'git',
	'make',
	'tr',
	'uniq',
	'diff',
	'cat',
	'tee',
	'chmod',
	'sha256sum',
	'shasum',
	'base64',
	'mktemp',
	'perl',
	'python3',
	'node',
	'bun',
	'npm',
	'npx',
	'sgrep',
]
const KINDS: [string, RegExp][] = [
	[
		'option',
		/(invalid|illegal|unrecognized|unknown) (option|predicate|primary|flag)|option requires an argument|invalid argument|extra operand|missing operand|unexpected argument|^usage:|try '.*--help'|invalid context|missing argument to|error parsing flag/i,
	],
	[
		'syntax',
		/syntax error|unknown command|unterminated|unmatched|unbalanced|regex parse error|invalid (regular expression|preceding|range|character class|back reference|content of)|parse error|compile error|unexpected (token|end)|bad (regex|pattern)|invalid time interval|invalid date/i,
	],
	[
		'file',
		/no such file or directory|cannot (open|access|stat)|permission denied|is a directory|not a directory|not found in/i,
	],
]

// Extracts the shell command from a native bash call or a tool/Action call.
function command(call: any): string | undefined {
	const i = call?.input ?? {}
	if (call?.name === 'bash') return typeof i.command === 'string' ? i.command : undefined
	const text = typeof i.cmd === 'string' ? i.cmd : typeof i.action === 'string' ? i.action : undefined
	const m = text?.match(/^\s*BASH\s*(?:\/\*[\s\S]*?\*\/\s*)?(["'`])/)
	if (!text || !m) return undefined
	let out = '',
		q = m[1]!,
		k = m.index! + m[0].length
	for (; k < text.length && text[k] !== q; k++) {
		if (text[k] !== '\\') {
			out += text[k]
			continue
		}
		const c = text[++k]
		out += c === 'n' ? '\n' : c === 't' ? '\t' : (c ?? '')
	}
	return out
}

type Call = { id: string; ts: string; cmd: string; out?: string }
const calls = new Map<string, Call>()
for (const s of readdirSync(dir)) {
	const f = join(dir, s, 'history.asonl')
	if (!existsSync(f)) continue
	for (const line of readFileSync(f, 'utf8').split('\n')) {
		if (!line.includes('tool_')) continue
		let e: any
		try {
			e = parse(line)
		} catch {
			continue
		}
		for (const b of [e.block, ...(e.blocks ?? [])].filter(Boolean)) {
			if (b.type === 'tool_call') {
				const cmd = command(b)
				if (cmd) calls.set(b.id, { id: b.id, ts: e.ts ?? '', cmd })
			} else if (b.type === 'tool_result' && calls.has(b.id)) {
				calls.get(b.id)!.out = typeof b.output === 'string' ? b.output : JSON.stringify(b.output)
			}
		}
	}
}
const recent = [...calls.values()]
	.filter((c) => c.out !== undefined)
	.sort((a, b) => a.ts.localeCompare(b.ts))
	.slice(-count)

const word = (t: string) => new RegExp(`(^|[\\s|;&(\`]|\\$\\()${t}(\\s|$)`, 'm')
const prefix = new RegExp(`^(?:[\\w./-]*/)?(${TOOLS.join('|')})(?:\\[\\d+\\])?: (.*)$`)
type Row = { uses: number; calls: Set<string>; kinds: Record<string, number>; samples: Record<string, string[]> }
const rows = new Map<string, Row>()
const row = (t: string) => rows.get(t) ?? rows.set(t, { uses: 0, calls: new Set(), kinds: {}, samples: {} }).get(t)!
let failed = 0
for (const c of recent) {
	const nonzero = !/^\[exit 0\]/.test(c.out!)
	if (/^\[exit [1-9]/.test(c.out!)) failed++
	for (const t of TOOLS) if (word(t).test(c.cmd)) row(t).uses++
	const lines = c.out!.split('\n').slice(0, 400)
	for (const [i, raw] of lines.entries()) {
		const line = raw.trim()
		let tool: string | undefined,
			msg = line
		const nf = line.match(/(?:^|: )([\w.+-]+): (?:command )?not found$/)
		if (nf && TOOLS.includes(nf[1]!)) {
			tool = nf[1]
			msg = 'command not found'
		} else {
			const m = line.match(prefix)
			if (m) {
				tool = m[1]
				msg = m[2]!
			} else {
				const u = line.match(/^usage: (\w+)/i)
				if (u && TOOLS.includes(u[1]!)) {
					tool = u[1]
					msg = line
				}
			}
		}
		if (!tool || /terminated by signal 13/.test(msg)) continue
		// A regex error names its cause a few lines later.
		if (/regex parse error/.test(msg))
			msg +=
				' ' +
				(lines
					.slice(i + 1, i + 8)
					.find((l) => /^\s*error:/.test(l))
					?.trim() ?? '')
		const kind = msg === 'command not found' ? 'missing' : (KINDS.find(([, r]) => r.test(msg))?.[0] ?? 'other')
		// "other" only counts plausible messages: a failed call, not printed code or data.
		if (kind === 'other' && (!nonzero || /^[\s{}'"\[\d]|,$/.test(msg))) continue
		const r = row(tool)
		if (r.calls.has(c.id + kind)) continue
		r.calls.add(c.id + kind)
		r.kinds[kind] = (r.kinds[kind] ?? 0) + 1
		const list = (r.samples[kind] ??= [])
		if (list.length < 3 && !list.includes(msg)) list.push(msg.slice(0, 160))
	}
}

// Host dialects: GNU tools name themselves in --version; BSD ones reject it.
const probe = (t: string) => {
	const p = Bun.spawnSync(['sh', '-c', `command -v ${t} >/dev/null || exit 127; ${t} --version 2>&1 | head -1`])
	if (p.exitCode === 127) return 'missing'
	const v = p.stdout.toString().trim()
	return /GNU|gawk|mawk/.test(v)
		? v
		: /BSD|illegal|unknown|usage/i.test(v) || !v
			? `BSD/other (${v.slice(0, 40) || 'no --version'})`
			: v.slice(0, 60)
}
console.log(
	`# Shell-tool errors: ${recent.length} most recent BASH calls (${recent[0]?.ts.slice(0, 10)} – ${recent.at(-1)?.ts.slice(0, 10)}), ${failed} exited non-zero\n`,
)
console.log(`Host: ${process.platform} ${process.arch}`)
for (const t of [
	'grep',
	'sed',
	'awk',
	'find',
	'xargs',
	'date',
	'stat',
	'tar',
	'timeout',
	'readlink',
	'rg',
	'fd',
	'jq',
	'sgrep',
])
	console.log(`- ${t}: ${probe(t)}`)
console.log('\n| tool | calls using | option | syntax | missing | file | other |\n|---|---:|---:|---:|---:|---:|---:|')
const k = (r: Row, x: string) => r.kinds[x] ?? 0
for (const [t, r] of [...rows]
	.filter(([, r]) => Object.keys(r.kinds).length)
	.sort((a, b) => b[1].calls.size - a[1].calls.size))
	console.log(
		`| ${t} | ${r.uses} | ${k(r, 'option')} | ${k(r, 'syntax')} | ${k(r, 'missing')} | ${k(r, 'file')} | ${k(r, 'other')} |`,
	)
console.log(
	'\nColumns count calls (not lines). option: unknown/illegal flag or usage error. syntax: bad expression, regex, date or interval. missing: command not found. file: missing path or permission. other: any other message the tool printed.',
)
if (examples)
	for (const [t, r] of rows)
		for (const [kind, list] of Object.entries(r.samples)) console.log(`\n${t} ${kind}:\n  ${list.join('\n  ')}`)
