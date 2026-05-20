import { expect, test } from 'bun:test'
import { risk } from './risk.ts'

function reasons(command: string): string[] {
	return risk.analyzeToolCall('bash', { command }).map((item) => item.reason)
}

test('rm -rf inside a specific /tmp child does not warn', () => {
	expect(reasons('rm -rf /tmp/hal-test')).toEqual([])
	expect(reasons('tmp=$(mktemp -d); rm -rf $tmp')).toEqual([])
	expect(reasons('TMP=/tmp/hal-verify; rm -rf "$TMP"')).toEqual([])
})

test('broad or non-temp rm -rf warns', () => {
	expect(reasons('rm -rf *')).toContain('DESTRUCTIVE RM -RF COMMAND')
	expect(reasons('rm -rf .')).toContain('DESTRUCTIVE RM -RF COMMAND')
	expect(reasons('rm -rf /tmp')).toContain('DESTRUCTIVE RM -RF COMMAND')
	expect(reasons('rm -rf /tmp/*')).toContain('DESTRUCTIVE RM -RF COMMAND')
	expect(reasons('rm -rf "$HOME/project"')).toContain('DESTRUCTIVE RM -RF COMMAND')
})

test('destructive git commands warn but plain stash does not', () => {
	expect(reasons('git stash')).toEqual([])
	expect(reasons('git stash drop')).toContain('DESTRUCTIVE GIT STASH DROP/CLEAR')
	expect(reasons('git reset --hard HEAD')).toContain('DESTRUCTIVE GIT RESET --HARD')
	expect(reasons('git clean -xfd')).toContain('DESTRUCTIVE GIT CLEAN')
	expect(reasons('git checkout -- src/foo.ts')).toContain('DESTRUCTIVE GIT CHECKOUT/RESTORE PATH')
	expect(reasons('git restore src/foo.ts')).toContain('DESTRUCTIVE GIT CHECKOUT/RESTORE PATH')
})

test('common secret-bearing paths produce reasons', () => {
	expect(reasons('cat ~/.ssh/id_rsa')).toContain('SSH private key likely contains secrets')
	expect(risk.analyzeToolCall('read', { path: '.npmrc' }).map((item) => item.reason)).toContain('.npmrc often contains registry auth tokens')
	expect(risk.analyzeToolCall('grep', { pattern: 'KEY', path: '.env.*' }).map((item) => item.reason)).toContain('.env files often contain secrets')
})

test('write/edit only check path, not body content', () => {
	const writeBody = risk.analyzeToolCall('write', { path: 'src/foo.ts', content: 'const s = "auth.ason"' })
	expect(writeBody).toEqual([])
	const editBody = risk.analyzeToolCall('edit', { path: 'src/foo.test.ts', operation: 'insert', after_ref: '0:000', new_content: 'read auth.ason example' })
	expect(editBody).toEqual([])
	// path itself still flagged
	expect(risk.analyzeToolCall('write', { path: 'auth.ason', content: 'x' }).map((item) => item.reason)).toContain('auth.ason contains provider credentials')
})

test('read/grep/glob only check path/pattern, not other fields', () => {
	// hypothetical extra field with secret-ish text should not trip
	expect(risk.analyzeToolCall('read', { path: 'src/foo.ts', note: 'auth.ason' }).map((item) => item.reason)).toEqual([])
})

test('bash still inspects full command for secret paths', () => {
	expect(reasons('cat auth.ason')).toContain('auth.ason contains provider credentials')
})
