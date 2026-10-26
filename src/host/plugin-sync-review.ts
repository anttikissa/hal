// The plugin review script (task b81), run by a remote terminal: it
// turns this home's comparison (plugin-sync-client.ts) into the steps of
// the host's hal/sync session (plugin-sync-session.ts), and
// keeps the terminal's indicator and notice current. Startup never
// moves focus or opens anything: the status row says how many portable
// plugins differ, and each newly found discrepancy gets one notice.
// A step applies the answer to the question it last asked in that
// session (only after the destination applied it does it say so), then
// asks about the first file still differing. Escape pauses the host's
// turn, so nothing reaches here and nothing is written.
// Tasks: b81.

import { hostname } from 'os'
import { join } from 'path'
import { diff as diffs } from '../common/diff.ts'
import type { Answers, Form } from '../common/forms.ts'
import { pluginSyncWire, type PluginSyncEvent } from '../common/plugin-sync.ts'
import { pluginReports } from './plugin-reports.ts'
import { pluginSync } from './plugin-sync.ts'
import { pluginSyncClient, StaleError, type Choice, type Discrepancy, type SideInfo } from './plugin-sync-client.ts'
import { textDiff } from './text-diff.ts'

type Asked = { file: string; client?: string; server?: string; labels: [string, string] }

const CLIENT = "Keep client's copy"
const SERVER = "Keep server's copy"
const keep = (file: string) => `Don't sync ${file} on this client`

const RELATION: Partial<Record<Discrepancy['relation'], string>> = {
	divergent: "Both changed it since they last matched, so either choice loses the other's changes.",
	unrelated: 'The two copies share no history.',
}
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
const when = (ts?: string) => (ts ? `${ts.slice(0, 16).replace('T', ' ')} UTC` : 'no date')
const absent = (s: SideInfo) => s.status === 'missing' || s.status === 'deleted'
const oneSided = (d: Discrepancy) => absent(d.client) !== absent(d.server)
const kept = 'The old copy stays in history.'

// What choosing the client's, then the server's, version does to `d`.
function labels(d: Discrepancy): [string, string] {
	if (!oneSided(d)) return [CLIENT, SERVER]
	return absent(d.server) ? [`Copy to ${host()}`, 'Delete here'] : [`Delete on ${host()}`, 'Copy here']
}

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
	let name = who === 'client' ? `**${me()}** (here)` : `**${host()}**`
	return `- ${who === 'client' ? 'Client' : 'Server'}: ${name}, ${STATUS[s.status]}edited ${when(s.ts)}${s.offline ? ' (offline)' : ''}${d.suggest === who ? ' ← newer' : ''}`
}

// What replacing `name`'s copy with text `to` (from text `from`) shows.
function change(name: string, file: string, from = '', to = ''): string {
	if (from === to) return `${file} on **${name}** keeps its text; only its history changes.`
	return [
		`${where(file)} on **${name}** changes:`,
		`\`+\` line added on ${name} · \`-\` line removed from ${name}`,
		diffs.fence(textDiff.text(from, to)),
		kept,
	].join('\n\n')
}

// When only one side has the file, the question is whether to copy or
// delete it: a diff of every line adds nothing, and deletion is never
// preselected.
function presence(d: Discrepancy): string {
	let mine = absent(d.server)
	let [has, lacks] = mine ? [d.client, d.server] : [d.server, d.client]
	let [hasWho, lacksWho] = mine
		? [`client (**${me()}**, here)`, `server (**${host()}**)`]
		: [`server (**${host()}**)`, `client (**${me()}**, here)`]
	let gone = lacks.status === 'deleted' ? `deleted it (${when(lacks.ts)})` : 'never had it'
	return `**${d.file}** is only on the ${hasWho}, edited ${when(has.ts)}. The ${lacksWho} ${gone}.`
}

// The question about `d`, with everything needed to answer it and what
// each answer does.
function describe(d: Discrepancy, texts: { client?: string; server?: string }): { say: string; ask: Form } {
	let file = d.file
	let nothing = `Nothing changes on either computer. This client stops comparing ${file}.`
	let ask = (initial: number, outcomes: [string, string]): Form => ({
		text: `${file}: which copy should both keep?`,
		fields: [
			{
				type: 'choice',
				name: 'choice',
				options: [...labels(d), keep(file)],
				initial,
				outcomes: [...outcomes, nothing],
			},
		],
	})
	if (oneSided(d)) {
		let [copy, gone] = [`${file} is copied to`, `${file} is deleted on`]
		let outcomes: [string, string] = absent(d.server)
			? [`${copy} **${host()}**.`, `${gone} **${me()}**. ${kept}`]
			: [`${gone} **${host()}**. ${kept}`, `${copy} **${me()}**.`]
		return { say: presence(d), ask: ask(absent(d.server) ? 0 : 1, outcomes) }
	}
	let lines = [
		`**${file}** is different on the client and the server.`,
		[side(d, 'client'), side(d, 'server')].join('\n'),
	]
	if (RELATION[d.relation]) lines.push(RELATION[d.relation]!)
	return {
		say: lines.join('\n\n'),
		ask: ask(d.suggest === 'client' ? 0 : d.suggest === 'server' ? 1 : 2, [
			change(host(), file, texts.server, texts.client),
			change(me(), file, texts.client, texts.server),
		]),
	}
}

// Carries out answer `value` to `asked`; what happened, to say.
async function act(asked: Asked, value: string): Promise<string> {
	let { file } = asked
	if (value === keep(file)) {
		await pluginSyncClient.ignore(file)
		return `Keeping ${file} separate: ${join(pluginSync.dir(), '.syncignore')} on this client now lists it, and neither file changed. Remove that line to compare it again.`
	}
	let choice: Choice | undefined =
		value === asked.labels[0] ? 'client' : value === asked.labels[1] ? 'server' : undefined
	if (!choice) return `"${value}" is not one of the choices for ${file}; nothing was written.`
	await pluginSyncClient.apply(file, choice, {
		...(asked.client ? { client: asked.client } : {}),
		...(asked.server ? { server: asked.server } : {}),
	})
	return `${value} for ${file}: ${choice === 'client' ? host() : 'this client'} applied it.`
}

// One step of session `session`: apply `answers` if they answer what
// it last asked, then ask about the next differing file.
async function review(session: string, answers?: Answers): Promise<void> {
	let rs = pluginSyncReview.state,
		said: string[] = [],
		ask: Form | undefined
	let asked = rs.asked.get(session)
	rs.asked.delete(session)
	try {
		if (answers?.choice !== undefined && asked) said.push(await pluginSyncReview.act(asked, answers.choice))
		else {
			if (answers?.choice !== undefined)
				said.push(
					'This terminal restarted since it asked, so it no longer knows which comparison that answer was for; nothing was written. Here is the current one.',
				)
			await pluginSyncClient.compare()
		}
	} catch (e: any) {
		said.push(e instanceof StaleError ? e.message : `Nothing was confirmed as applied: ${e?.message ?? e}`)
	}
	try {
		let st = pluginSyncClient.state,
			d = st.discrepancies[0]
		if (st.error) said.push(`The last comparison failed: ${st.error}`)
		if (d) {
			let q = pluginSyncReview.describe(d, await pluginSyncClient.diff(d.file))
			said.push(q.say)
			ask = q.ask
			rs.asked.set(session, {
				file: d.file,
				...(d.client.id ? { client: d.client.id } : {}),
				...(d.server.id ? { server: d.server.id } : {}),
				labels: labels(d),
			})
		} else if (!st.error) {
			let ex = st.excluded.map((x) => `${x.file} (ignored by ${x.by === 'both' ? 'both sides' : `the ${x.by}`})`)
			said.push(`Synced files match ${host()}.${ex.length ? ` Not compared: ${ex.join(', ')}.` : ''}`)
		}
	} catch (e: any) {
		said.push(`Could not prepare the next comparison: ${e?.message ?? e}`)
	}
	pluginSyncClient.send({ type: 'sync', op: 'step', session, say: said.join('\n\n'), ...(ask ? { ask } : {}) })
}

export const pluginSyncReview = {
	// `asked`: per review session, the file and versions it last asked
	// about; `announced`: discrepancies already given a notice.
	state: { asked: new Map<string, Asked>(), announced: new Set<string>() },
	show: (_text?: string): void => {},
	start,
	changed,
	describe,
	act,
	review,
}
