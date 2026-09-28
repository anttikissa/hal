import { expect, test } from 'bun:test'
import type { ToolCallBlock } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { approval } from './approval.ts'

const bash = (command: string, id = 'c1'): ToolCallBlock => ({ type: 'tool_call', id, name: 'bash', input: { command, description: 'x' } })

// The offending parts of a bash command, as the form marks them.
function marked(command: string): string[] {
	let form = approval.form(bash(command))
	return (form?.quote?.marks ?? []).map(([a, b]) => command.slice(a, b))
}

test('dangerous commands are caught and their offending part marked; harmless ones are not', () => {
	let table: [string, string[]][] = [
		['rm -rf build', ['rm -rf build']],
		['cd src && rm -fr node_modules && ls', ['rm -fr node_modules']],
		['rm -r -f ~/x', ['rm -r -f ~/x']],
		['rm --recursive --force ./out', ['rm --recursive --force ./out']],
		['git reset --hard HEAD~1', ['git reset --hard HEAD~1']],
		['git clean -fdx', ['git clean -fdx']],
		['git stash drop', ['git stash drop']],
		['git push --force origin main', ['git push --force origin main']],
		['git push -f', ['git push -f']],
		['git checkout -- src/a.ts', ['git checkout -- src/a.ts']],
		['git restore src/a.ts', ['git restore src/a.ts']],
		['rm -rf /tmp', ['rm -rf /tmp']],
		['rm -rf /tmp/../etc', ['rm -rf /tmp/../etc']],
		['echo hi; git reset --hard; rm -rf dist', ['git reset --hard', 'rm -rf dist']],
		// Models overuse rm -f; it is rarely dangerous.
		['rm -f a.txt', []],
		['rm a.txt', []],
		['rm -rf /tmp/hal-test-1', []],
		['D=$(mktemp -d); rm -rf $D', []],
		['git checkout -b feature', []],
		// v followed by a digit is a version tag, not a file.
		['git checkout v1.2', []],
		['git checkout v1.2 -- src/a.ts', ['git checkout v1.2 -- src/a.ts']],
		['git push origin main', []],
		['git reset HEAD a.ts', []],
		['ls -rf', []],
	]
	for (let [command, parts] of table) expect([command, marked(command)]).toEqual([command, parts])
})

test('only bash is checked, and the form asks y/N with No as default', () => {
	expect(approval.form({ type: 'tool_call', id: 'r', name: 'read', input: { path: 'rm -rf x' } })).toBeUndefined()
	let form = approval.form(bash('rm -rf build'))!
	expect(form.fields).toEqual([{ type: 'choice', name: 'run', options: ['yes', 'no'], initial: 1 }])
	expect(form.quote!.text).toBe('rm -rf build')
})

const at = (r: object) => ({ ...r, ts: '2026-09-27T00:00:00Z' }) as HistoryRecord
const call = (id: string, command = 'rm -rf x') => at({ type: 'assistant', block: bash(command, id) })
const q = (id: string, callId: string) => at({ type: 'question', id, form: approval.form(bash('rm -rf x'))!, call: callId })
const a = (question: string, run: string) => at({ type: 'answer', question, answers: { run } })
const prompt = at({ type: 'user', blocks: [{ type: 'text', text: 'go' }] })

test('calls held for approval are found with the decisions so far, until they ran or a crash may have run them', () => {
	let held = (records: HistoryRecord[]) => {
		let h = approval.held(records)
		return h && { calls: h.calls.map((c) => c.id), decided: Object.fromEntries(h.decided) }
	}
	// Asked, then answered: run with the decision.
	expect(held([prompt, call('c1'), call('c2'), q('q1', 'c1'), a('q1', 'no')])).toEqual({ calls: ['c1', 'c2'], decided: { c1: false } })
	expect(held([prompt, call('c1'), call('c2'), q('q1', 'c1'), a('q1', 'no'), q('q2', 'c2'), a('q2', 'yes')])).toEqual({
		calls: ['c1', 'c2'],
		decided: { c1: false, c2: true },
	})
	// Paused at a question and continued: nothing ran, so ask again.
	let paused = at({ type: 'turn_end', status: 'paused', usage: {} })
	expect(held([prompt, call('c1'), q('q1', 'c1'), paused, at({ type: 'continue' })])).toEqual({ calls: ['c1'], decided: {} })
	// All answered, then a host continued it: the calls may have run.
	expect(held([prompt, call('c1'), q('q1', 'c1'), a('q1', 'yes'), at({ type: 'continue' })])).toBeUndefined()
	// Never asked (a crash mid-round), or results recorded.
	expect(held([prompt, call('c1')])).toBeUndefined()
	expect(held([prompt, call('c1'), q('q1', 'c1'), a('q1', 'yes'), at({ type: 'user', blocks: [{ type: 'tool_result', id: 'c1', output: 'ok' }] })])).toBeUndefined()
})

test('rm -rf after cd into /tmp or a mktemp dir runs without asking, as far as the cd can be followed', () => {
	let free = [
		'cd /tmp; rm -rf build',
		'cd /tmp\nrm -rf build',
		'cd /tmp/x && rm -rf y',
		'cd "$(mktemp -d)" && make && rm -rf out',
		'D=$(mktemp -d) && cd $D && rm -rf out',
		'cd /tmp && cd x && rm -rf y',
		'cd /tmp; echo hi; rm -rf ./build',
	]
	for (let command of free) expect([command, marked(command)]).toEqual([command, []])
	let asks = [
		'cd /tmp; cd ~; rm -rf x',
		'cd /tmp/../home && rm -rf x',
		'rm -rf /tmp/../x',
		// cd may fail, and then rm runs where the command started.
		'cd /tmp/x; rm -rf y',
		'cd /tmp/x || rm -rf y',
		'cd /tmp/x && make; rm -rf y',
		'cd /tmp/x && cd /tmp; rm -rf y',
		// Unfollowable: other variables, subshells, braces, eval, home.
		'cd $HOME && rm -rf x',
		'cd /tmp && { cd ~; } && rm -rf x',
		'cd /tmp && eval "cd ~" && rm -rf x',
		'cd /tmp & rm -rf x',
		'cd /tmp; cd; rm -rf x',
		'cd /tmp && rm -rf ~/x',
		'cd /tmp && rm -rf .',
		'cd /tmp && rm -rf *',
		'cd /tmp && rm -rf ../etc',
		'cd /tmp && rm -rf $X',
	]
	for (let command of asks) expect([command, marked(command).length > 0]).toEqual([command, true])
})
