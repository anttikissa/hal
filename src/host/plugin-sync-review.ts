// The plugin review script (task b81), run by a remote terminal: it
// turns this home's comparison (plugin-sync-client.ts) into the steps of
// the host's hal/sync session (plugin-sync-session.ts), and
// keeps the terminal's indicator and notice current. Startup never
// moves focus or opens anything: the status row says how many portable
// plugins differ, and each newly found discrepancy gets one notice.
// A step applies the answer to the question it last asked in that
// session (only after the destination applied it does it say so), then
// asks about the first file still differing. Escape answers Not now
// (or Done).
// Tasks: b81.

import { rmSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import { diff as diffs } from '../common/diff.ts'
import type { Answers, Form } from '../common/forms.ts'
import { pluginSyncWire, type PluginSyncEvent } from '../common/plugin-sync.ts'
import { titles } from '../common/titles.ts'
import { configSync } from './config-sync.ts'
import { pluginHistory } from './plugin-history.ts'
import { pluginReports } from './plugin-reports.ts'
import { pluginSync } from './plugin-sync.ts'
import { pluginSyncClient, StaleError, type Choice, type Discrepancy, type SideInfo } from './plugin-sync-client.ts'
import { textDiff } from './text-diff.ts'

// What an answer does: copy one side's version, use the merge, send the
// file as merged by hand, ask later, stop or resume syncing, or end.
type Action = Choice | 'merge' | 'mine' | 'later' | 'never' | 'again' | 'done'
type Asked = {
	acts: Record<string, { do: Action; file: string }>
	// What Escape answers.
	skip: string
	client?: string
	server?: string
	merged?: string
	key?: string
}
type Texts = { client?: string; server?: string; base?: string }
type Merged = { text: string; conflicts: number }

const LATER = 'Not now'
const DONE = 'Done'
const never = (file: string) => `Never sync ${file} on ${me()}`

const STATUS: Record<SideInfo['status'], string> = {
	present: '',
	empty: 'empty file, ',
	deleted: 'deleted, ',
	missing: 'missing, ',
}

const host = () => pluginSyncClient.state.name
// This computer's name: its hostname without the domain.
const me = () => hostname().split('.')[0] || 'this computer'
const key = (d: Discrepancy) => `${d.file} ${d.client.id ?? ''} ${d.server.id ?? ''}`
const where = (file: string) => (pluginSyncWire.isPlugin(file) ? `plugins/${file}` : file)
const when = (ts?: string) => (ts ? titles.time(ts).replace(/^Yesterday/, 'yesterday') : 'at no recorded time')
const absent = (s: SideInfo) => s.status === 'missing' || s.status === 'deleted'
const oneSided = (d: Discrepancy) => absent(d.client) !== absent(d.server)
const copies = (file: string) => [`${pluginHistory.filePath(file)}.local`, `${pluginHistory.filePath(file)}.server`]
const kept = 'The old copy stays in history.'

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

// Starts comparing with host `name`; `show` puts the indicator (or
// nothing) in the status row.
function start(name: string, show: (text?: string) => void): void {
	pluginSyncReview.show = show
	pluginSyncClient.onChange = () => pluginSyncReview.changed()
	pluginSyncClient.onReview = (e: PluginSyncEvent) => void pluginSyncReview.review(e.review!, e.answers)
	pluginSyncClient.start(name)
}

// The comparison changed: the indicator follows it, and files that
// newly differ (or differ in a new way) get one notice.
function changed(): void {
	let st = pluginSyncClient.state,
		rs = pluginSyncReview.state
	let list = st.same ? [] : st.discrepancies
	pluginSyncReview.show(list.length ? `Files differ (${list.length}) — /sync` : undefined)
	let fresh = list.filter((d) => !rs.announced.has(key(d)))
	rs.announced = new Set(list.map(key))
	if (fresh.length)
		pluginReports.deliver({
			type: 'notice',
			session: '',
			name: 'Files differ',
			what: `from ${host()}`,
			kind: 'update',
			line: `${fresh.map((d) => d.file).join(', ')} — /sync`,
			key: 'sync',
		})
}

function side(d: Discrepancy, who: Choice): string {
	let s = d[who]
	let name = who === 'client' ? `**${me()}** (this computer)` : `**${host()}** (server)`
	return `- ${name}: ${STATUS[s.status]}changed ${when(s.ts)}`
}

// When only one side has the file, the question is whether to copy or
// delete it: a diff of every line adds nothing, and deletion is never
// preselected.
function presence(d: Discrepancy): string {
	let mine = absent(d.server)
	let [has, lacks] = mine ? [d.client, d.server] : [d.server, d.client]
	let [hasWho, lacksWho] = mine
		? [`client (**${me()}**, this computer)`, `server (**${host()}**)`]
		: [`server (**${host()}**)`, `client (**${me()}**, this computer)`]
	let gone = lacks.status === 'deleted' ? `deleted it (${when(lacks.ts)})` : 'never had it'
	let subject = d.file === 'config.ason' ? 'Portable settings in **config.ason**' : `**${d.file}**`
	return `${subject} ${d.file === 'config.ason' ? 'are' : 'is'} only on the ${hasWho}, changed ${when(has.ts)}. The ${lacksWho} ${gone}.`
}

// How the two copies relate, in one line: who has changes, and whether
// they merge.
function intro(d: Discrepancy, texts: Texts, m: Merged): string {
	let [mine, theirs] = [`**${me()}**`, `**${host()}**`]
	if (m.conflicts) {
		let [local, server] = copies(d.file)
		return `${mine} and ${theirs} have incompatible changes to **${d.file}** in ${count(m.conflicts, 'place')}; choose how to resolve. Both copies are beside it to merge by hand: ${local} and ${server}.`
	}
	if (m.text === texts.client) return `${mine} has changes to **${d.file}**; ${theirs} can fast-forward.`
	if (m.text === texts.server) return `${theirs} has changes to **${d.file}**; ${mine} can fast-forward.`
	return `Both have changes to **${d.file}**; they merge cleanly.`
}

// The question about `d`, with everything needed to answer it and what
// each answer does.
function describe(d: Discrepancy, texts: Texts): { say: string; ask: Form; asked: Asked; conflicts?: number } {
	let file = d.file
	let options: [string, Action, string][] = []
	let say: string,
		merged: Merged | undefined,
		initial: Action = 'later'
	if (oneSided(d)) {
		let gone = file === 'config.ason' ? 'Portable settings are cleared on' : `${file} is deleted on`
		let copy = file === 'config.ason' ? 'Portable settings are copied to' : `${file} is copied to`
		let remove = file === 'config.ason' ? 'Clear portable settings' : 'Delete'
		if (absent(d.server))
			options.push(
				[`Copy to ${host()}`, 'client', `${copy} **${host()}**.`],
				[`${remove} here`, 'server', `${gone} **${me()}**. ${kept}`],
			)
		else
			options.push(
				[`${remove} on ${host()}`, 'client', `${gone} **${host()}**. ${kept}`],
				['Copy here', 'server', `${copy} **${me()}**.`],
			)
		say = presence(d)
		initial = absent(d.server) ? 'client' : 'server'
	} else {
		let { client = '', server = '', base } = texts
		let m = (merged =
			file === 'config.ason' ? configSync.combine(base, client, server) : textDiff.merge(base ?? '', client, server))
		// Each computer's changes since the version both share: git diff -c
		// of the base against both copies, its signs flipped so + is what
		// that computer added. Column 0 is this computer, column 1 the host.
		let flip = (row: string) => row.replace(/^[-+ ]{2}/, (m) => m.replace(/[-+]/g, (c) => (c === '+' ? '-' : '+')))
		let rows = textDiff
			.combined(base ?? '', client, server)
			.split('\n')
			.map(flip)
		// One computer's changes alone, in its column: the other's additions
		// drop out, its deletions become context, and one line of context
		// stays around each change, … marking the gaps.
		let only = (col: number) => {
			let lines = rows.flatMap((r) => {
				if (r === '…' || r[col] !== ' ')
					return [r === '…' ? r : col ? ` ${r[1]}${r.slice(2)}` : `${r[0]} ${r.slice(2)}`]
				return r[1 - col] === '+' ? [] : [`  ${r.slice(2)}`]
			})
			let changed = (i: number) => lines[i] !== undefined && lines[i] !== '…' && !lines[i]!.startsWith('  ')
			let shown: string[] = []
			let last = -1
			lines.forEach((r, i) => {
				if (r === '…' || !(changed(i - 1) || changed(i) || changed(i + 1))) return
				if (shown.length && i > last + 1) shown.push('…')
				shown.push(r)
				last = i
			})
			return shown
		}
		// A choice's preview: the changes it keeps, under a legend of the
		// marks shown, each in the colors of the computer that made them.
		let preview = (shown: string[]) => {
			let marks = (col: number, name: string) =>
				[
					['+', 'added'],
					['-', 'deleted'],
				].flatMap(([mark, verb]) =>
					shown.some((r) => r[col] === mark) ? [`${' '.repeat(col)}${mark}${' '.repeat(2 - col)}${name} ${verb}`] : [],
				)
			let legend = [...marks(0, me()), ...marks(1, host())]
			return legend.length ? `\n\n${diffs.fence([...legend, '', ...shown].join('\n'), 'combined-diff')}` : ''
		}
		let shows: Partial<Record<Action, string>> = {
			merge: preview(rows),
			mine: preview(rows),
			client: preview(only(0)),
			server: preview(only(1)),
		}
		if (m.conflicts)
			options.push([
				'I merged it myself',
				'mine',
				`${where(file)} on **${me()}**, as it is when you answer, goes to **${host()}**. ${kept}${shows.mine}`,
			])
		else {
			let ff: Action = m.text === server ? 'server' : m.text === client ? 'client' : 'merge'
			let [label, outcome] =
				ff === 'merge'
					? ['Use both changes', 'Both computers get both changes.']
					: ff === 'server'
						? [`Use ${host()}'s changes`, `**${me()}** gets the changes on **${host()}**.`]
						: [`Use ${me()}'s changes`, `**${host()}** gets the changes on **${me()}**.`]
			options.push([label, ff, `${outcome} ${kept}${shows[ff]}`])
		}
		if (m.conflicts || m.text !== server)
			options.push([
				`Use ${host()}'s copy`,
				'server',
				`**${me()}** gets the copy on **${host()}**. ${kept}${shows.server}`,
			])
		if (m.conflicts || m.text !== client)
			options.push([
				`Use ${me()}'s copy`,
				'client',
				`**${host()}** gets the copy on **${me()}**. ${kept}${shows.client}`,
			])
		say = [intro(d, texts, m), [side(d, 'client'), side(d, 'server')].join('\n')].join('\n\n')
		initial = m.conflicts ? 'later' : 'merge'
	}
	options.push(
		[LATER, 'later', 'Nothing changes. /sync asks again next time.'],
		[
			never(file),
			'never',
			`Nothing changes on either computer. **${me()}** stops syncing ${file}; /sync lists it so you can sync it again.`,
		],
	)
	let ask: Form = {
		text: `Sync ${file}?`,
		fields: [
			{
				type: 'choice',
				name: 'choice',
				options: options.map((o) => o[0]),
				initial: options.findIndex((o) => o[1] === initial),
				outcomes: options.map((o) => o[2]),
			},
		],
		skip: true,
	}
	let asked: Asked = {
		acts: Object.fromEntries(options.map(([label, action]) => [label, { do: action, file }])),
		skip: LATER,
		key: key(d),
		...(d.client.id ? { client: d.client.id } : {}),
		...(d.server.id ? { server: d.server.id } : {}),
		...(merged && !merged.conflicts ? { merged: merged.text } : {}),
	}
	return { say, ask, asked, ...(merged?.conflicts ? { conflicts: merged.conflicts } : {}) }
}

// The last question: files this client never syncs, to sync one again.
function resume(files: string[]): { ask: Form; asked: Asked } {
	let options = files.map((f) => `Sync ${f} again`)
	return {
		ask: {
			text: `**${me()}** never syncs ${files.join(', ')}. Sync one again?`,
			fields: [{ type: 'choice', name: 'choice', options: [...options, DONE], initial: options.length }],
			skip: true,
		},
		asked: {
			acts: Object.fromEntries([
				...files.map((f, i) => [options[i]!, { do: 'again' as const, file: f }]),
				[DONE, { do: 'done' as const, file: '' }],
			]),
			skip: DONE,
		},
	}
}

// Carries out answer `value` to `asked` in session `session`; what
// happened, to say.
async function act(asked: Asked, value: string, session: string): Promise<string> {
	let a = asked.acts[value]
	if (!a) return `"${value}" is not one of the choices; nothing was written.`
	let { file } = a
	let expected = {
		...(asked.client ? { client: asked.client } : {}),
		...(asked.server ? { server: asked.server } : {}),
	}
	if (a.do === 'done') return ''
	if (a.do === 'later') {
		pluginSyncReview.state.later.get(session)?.add(asked.key!)
		return `Skipped ${file} for now.`
	}
	if (a.do === 'never') {
		await pluginSyncClient.ignore(file)
		return `**${me()}** no longer syncs ${file}: ${join(pluginSync.dir(), '.syncignore')} lists it. /sync offers to sync it again.`
	}
	if (a.do === 'again') {
		await pluginSyncClient.unignore(file)
		return `**${me()}** syncs ${file} again.`
	}
	if (a.do === 'merge' || a.do === 'mine') await pluginSyncClient.settle(file, asked.merged, expected)
	else await pluginSyncClient.apply(file, a.do, expected)
	for (let path of copies(file)) rmSync(path, { force: true })
	let done = a.do === 'server' ? me() : a.do === 'client' ? host() : 'both computers'
	return `${value} for ${file}: ${done} applied it.`
}

// One step of session `session`: apply `answers` if they answer what
// it last asked (none: Escape skipped it), then ask about the next
// differing file not skipped for now.
async function review(session: string, answers?: Answers): Promise<void> {
	let rs = pluginSyncReview.state,
		said: string[] = [],
		ask: Form | undefined
	let asked = rs.asked.get(session)
	rs.asked.delete(session)
	let later = rs.later.get(session) ?? new Set<string>()
	rs.later.set(session, later)
	try {
		if (asked) said.push(await pluginSyncReview.act(asked, answers?.choice ?? asked.skip, session))
		else {
			if (answers?.choice !== undefined)
				said.push(
					'This terminal restarted since it asked, so it no longer knows which comparison that answer was for; nothing was written. Here is the current one.',
				)
			else later.clear()
			await pluginSyncClient.compare()
		}
	} catch (e: any) {
		said.push(e instanceof StaleError ? e.message : `Nothing was confirmed as applied: ${e?.message ?? e}`)
	}
	try {
		let st = pluginSyncClient.state,
			d = st.discrepancies.find((x) => !later.has(key(x)))
		if (st.error) said.push(`The last comparison failed: ${st.error}`)
		if (d) {
			let texts = await pluginSyncClient.diff(d.file)
			let q = pluginSyncReview.describe(d, texts)
			if (q.conflicts) {
				let [local, server] = copies(d.file)
				writeFileSync(local!, texts.client ?? '')
				writeFileSync(server!, texts.server ?? '')
			}
			said.push(q.say)
			ask = q.ask
			rs.asked.set(session, q.asked)
		} else if (!st.error) {
			let skipped = st.discrepancies.map((x) => x.file)
			said.push(
				skipped.length ? `Skipped for now: ${skipped.join(', ')}. /sync asks again.` : `Synced files match ${host()}.`,
			)
			let theirs = st.excluded.filter((x) => x.by !== 'client').map((x) => x.file)
			if (theirs.length) said.push(`**${host()}** never syncs ${theirs.join(', ')}.`)
			let mine = st.excluded.filter((x) => x.by !== 'server').map((x) => x.file)
			if (mine.length && asked?.skip !== DONE) {
				let q = resume(mine)
				ask = q.ask
				rs.asked.set(session, q.asked)
			}
		}
	} catch (e: any) {
		said.push(`Could not prepare the next comparison: ${e?.message ?? e}`)
	}
	pluginSyncClient.send({
		type: 'sync',
		op: 'step',
		session,
		say: said.filter(Boolean).join('\n\n'),
		...(ask ? { ask } : {}),
	})
}

export const pluginSyncReview = {
	// `asked`: per review session, what it last asked; `later`: per
	// session, discrepancies skipped until the next /sync; `announced`:
	// discrepancies already given a notice.
	state: { asked: new Map<string, Asked>(), later: new Map<string, Set<string>>(), announced: new Set<string>() },
	show: (_text?: string): void => {},
	start,
	changed,
	describe,
	act,
	review,
}
