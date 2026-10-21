import { expect, test } from 'bun:test'
import type { ToolCallBlock } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { settings } from '../common/settings.ts'
import { approval } from './approval.ts'

const bash = (command: string, id = 'c1'): ToolCallBlock => ({
	type: 'tool_call',
	id,
	name: 'bash',
	input: { command, description: 'x' },
})

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
		['dir=; rm -rf ~/projects/$DIR', ['rm -rf ~/projects/$DIR']],
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
		['T=$(mktemp -d /tmp/x.XXXX); rm -rf $T', []],
		['n=/tmp/ws; rm -rf $n/src $n/home-*', []],
		// A failed mktemp leaves T empty: $T/x is /x.
		['T=$(mktemp -d); rm -rf $T/x', ['rm -rf $T/x']],
		['n=/tmp/ws; n=/; rm -rf $n/src', ['rm -rf $n/src']],
		['n=/tmp/ws; rm -rf $n/../x', ['rm -rf $n/../x']],
		['rm -rf /tmp/./*', ['rm -rf /tmp/./*']],
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

test('only bash is checked, and the form asks y/N with No as default, giving each reason once', () => {
	expect(approval.form({ type: 'tool_call', id: 'r', name: 'read', input: { path: 'rm -rf x' } })).toBeUndefined()
	let form = approval.form(bash('rm -rf build; rm -rf dist; git reset --hard'))!
	expect(form.fields).toEqual([{ type: 'choice', name: 'run', options: ['yes', 'no'], initial: 1 }])
	expect(form.quote!.text).toBe('rm -rf build; rm -rf dist; git reset --hard')
	expect(form.text).toBe(
		'Approval needed\nMay wipe out important files by accident.\nThrows away uncommitted changes.\n/help security to learn more.',
	)
})

test('env dumps are caught; ps without env options is not', () => {
	let table: [string, string[]][] = [
		['ps -E', ['ps -E']],
		['ps -ax -o pid,command -E | grep x', ['ps -ax -o pid,command -E']],
		['ps -wwE -p 1', ['ps -wwE -p 1']],
		['ps e', ['ps e']],
		['ps auxe', ['ps auxe']],
		['cat /proc/self/environ', ['/proc/self/environ']],
		['tr "\\0" "\\n" < /proc/123/environ', ['/proc/123/environ']],
		['ps aux', []],
		['ps -e', []],
		['ps -o user,pid', []],
		['echo ps -E', []],
	]
	for (let [command, parts] of table) expect([command, marked(command)]).toEqual([command, parts])
	expect(approval.form(bash('ps -E'))!.text.split('\n')[1]).toStartWith('Reveals env variables.')
	expect(approval.sensitive('/proc/1/environ')).toBe(true)
})

test('secret-printing approvals are narrow, use the shared path policy and honor security yolo', () => {
	let table: [string, string[]][] = [
		['cat ~/.ssh/id_rsa', ['cat ~/.ssh/id_rsa']],
		['head -n 5 "$HOME/.aws/credentials"', ['head -n 5 "$HOME/.aws/credentials"']],
		["tail -f './.env.local'", ["tail -f './.env.local'"]],
		['cat -- "/tmp/key files/id_ed25519"', ['cat -- "/tmp/key files/id_ed25519"']],
		['printf ready | cat ~/.ssh/*', ['cat ~/.ssh/*']],
		['/bin/cat secrets/token.txt', ['/bin/cat secrets/token.txt']],
		['/usr/bin/head <.env', ['/usr/bin/head <.env']],
		['head wallet.dat', ['head wallet.dat']],
		['cat ~/.config/solana/id.json', ['cat ~/.config/solana/id.json']],
		['cat AGENTS.md', []],
		['head src/host/secrets.ts', []],
		['ssh -i ~/.ssh/id_rsa example.invalid', []],
		// Public keys are meant to be shared.
		['cat ~/.ssh/id_ed25519.pub', []],
		['echo "cat ~/.ssh/id_rsa"', []],
	]
	for (let [command, parts] of table) expect([command, marked(command)]).toEqual([command, parts])
	let original = settings.security
	try {
		settings.security = () => 'yolo'
		expect(approval.form(bash('cat ~/.ssh/id_rsa'))).toBeUndefined()
	} finally {
		settings.security = original
	}
})

test('wallet-specific paths are sensitive without banning ordinary data files or source names', () => {
	let sensitive = [
		'wallet.dat',
		'backup/wallet.dat-journal',
		'backup/wallet.dat-wal',
		'backup/wallet.dat-shm',
		'~/.electrum/wallets/default_wallet',
		'~/.electrum/testnet/wallets/custom',
		'Electrum/wallets',
		'~/.electron-cash/wallets/default_wallet',
		'Electron Cash/wallets/custom',
		'.ethereum/keystore/UTC--2026-10-14T12-00-00--address',
		'~/.config/solana/id.json',
		'Monero/wallets/personal.keys',
		'Library/Application Support/Exodus/exodus.wallet',
		'exodus.wallet/storage.seco',
		'~/.sparrow/wallets/personal.mv.db',
		'~/.sparrow/testnet/wallets/personal.mv.db',
		'~/.local/share/sparrow/wallets/personal.mv.db',
		'Sparrow/wallets',
		'~/.walletwasabi/client/Wallets/personal.json',
		'WalletWasabi/Client/Wallets',
		'Local Extension Settings/nkbihfbeogaeaoehlefnkodbefgpgknn/000003.ldb',
	]
	let ordinary = [
		'wallet.dat.txt',
		'wallet.data',
		'UTC-not-a-wallet.txt',
		'id.json',
		'catalog.dat',
		'config.json',
		'cache.ldb',
		'database.mv.db',
		'wallets/config.json',
		'.electrum/config',
		'.sparrow/config',
		'.walletwasabi/client/Config.json',
		'src/wallet.dat.ts',
		'src/key.keys.ts',
		'exodus.wallet.ts',
		'Local Extension Settings/another-extension/000003.ldb',
	]
	for (let path of sensitive) expect([path, approval.sensitive(path)]).toEqual([path, true])
	for (let path of ordinary) expect([path, approval.sensitive(path)]).toEqual([path, false])
})

const at = (r: object) => ({ ...r, ts: '2026-09-27T00:00:00Z' }) as HistoryRecord
const call = (id: string, command = 'rm -rf x') => at({ type: 'assistant', block: bash(command, id) })
const q = (id: string, callId: string) =>
	at({ type: 'question', id, form: approval.form(bash('rm -rf x'))!, call: callId })
const a = (question: string, run: string) => at({ type: 'answer', question, answers: { run } })
const prompt = at({ type: 'user', blocks: [{ type: 'text', text: 'go' }] })

test('calls held for approval are found with the decisions so far, until they ran or a crash may have run them', () => {
	let held = (records: HistoryRecord[]) => {
		let h = approval.held(records)
		return h && { calls: h.calls.map((c) => c.id), decided: Object.fromEntries(h.decided) }
	}
	// Asked, then answered: run with the decision.
	expect(held([prompt, call('c1'), call('c2'), q('q1', 'c1'), a('q1', 'no')])).toEqual({
		calls: ['c1', 'c2'],
		decided: { c1: false },
	})
	expect(held([prompt, call('c1'), call('c2'), q('q1', 'c1'), a('q1', 'no'), q('q2', 'c2'), a('q2', 'yes')])).toEqual({
		calls: ['c1', 'c2'],
		decided: { c1: false, c2: true },
	})
	// Paused at a question and continued: nothing ran, so ask again.
	let paused = at({ type: 'turn_end', status: 'paused', usage: {} })
	expect(held([prompt, call('c1'), q('q1', 'c1'), paused, at({ type: 'continue' })])).toEqual({
		calls: ['c1'],
		decided: {},
	})
	// All answered, then a host continued it: the calls may have run.
	expect(held([prompt, call('c1'), q('q1', 'c1'), a('q1', 'yes'), at({ type: 'continue' })])).toBeUndefined()
	// Never asked (a crash mid-round), or results recorded.
	expect(held([prompt, call('c1')])).toBeUndefined()
	expect(
		held([
			prompt,
			call('c1'),
			q('q1', 'c1'),
			a('q1', 'yes'),
			at({ type: 'user', blocks: [{ type: 'tool_result', id: 'c1', output: 'ok' }] }),
		]),
	).toBeUndefined()
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
