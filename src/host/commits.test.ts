import { expect, test } from 'bun:test'
import type { HistoryRecord } from '../common/replay.ts'
import { commits } from './commits.ts'

// Task pdw: a Session trailer is confirmed by the claimed session's own
// calls. Commit at unix second 1000; records are that session's history.
const at = (s: number) => new Date(s * 1000).toISOString()
const call = (id: string, command: string, s: number) => ({ type: 'assistant', block: { type: 'tool_call', id, name: 'bash', input: { command } }, ts: at(s), n: 0 }) as unknown as HistoryRecord
const result = (id: string, output: string, s: number) => ({ type: 'user', blocks: [{ type: 'tool_result', id, output }], ts: at(s), n: 0 }) as unknown as HistoryRecord

test('a trailer is confirmed by a running commit command or a printed hash; else it warns once results are in', () => {
	// A quiet commit (no hash printed): the running call's command says commit.
	expect(commits.check([call('a', 'git commit -q -F msg', 999)], 'abc1234', 1000)).toBe('yes')
	// A wrong trailer: the claimed session ran something else then.
	expect(commits.check([call('a', './test', 990), result('a', 'ok', 1005)], 'abc1234', 1000)).toBe('no')
	expect(commits.check([], 'abc1234', 1000)).toBe('no')
	// A call still running then: wait for its result, which may print the hash.
	let running = [call('a', 'scripts/ship', 995)]
	expect(commits.check(running, 'abc1234', 1000)).toBe('wait')
	expect(commits.check([...running, result('a', '[main abc1234] Fix', 1003)], 'abc1234', 1000)).toBe('yes')
	// Output from before the commit does not count; a call that ended before it was not running.
	expect(commits.check([call('a', 'git commit', 900), result('a', 'abc1234', 950)], 'abc1234', 1000)).toBe('no')
})
