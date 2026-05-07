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
