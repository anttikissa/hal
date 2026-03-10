#!/usr/bin/env bun
// Interactive first-run setup: providers + permissions.

import * as readline from 'readline'
import { liveFile } from '../src/utils/live-file.ts'

const HAL_DIR = process.env.HAL_DIR ?? import.meta.dir + '/..'
const STATE_DIR = process.env.HAL_STATE_DIR ?? `${HAL_DIR}/state`
const CONFIG_PATH = `${HAL_DIR}/config.ason`
const AUTH_PATH = `${HAL_DIR}/auth.ason`

import { mkdirSync, existsSync } from 'fs'
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })

const config = liveFile(CONFIG_PATH, { defaults: { defaultModel: 'anthropic/claude-opus-4-6' } as any })
const auth = liveFile(AUTH_PATH, { defaults: {} as any })

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function ask(q: string): Promise<string> {
	return new Promise(r => rl.question(q, r))
}

async function askChoice(q: string, options: string[]): Promise<string> {
	while (true) {
		const a = (await ask(q)).trim().toLowerCase()
		if (options.includes(a)) return a
		console.log(`  Please enter one of: ${options.join(', ')}`)
	}
}

// ── Providers ──

console.log('\n🔧 HAL Setup\n')
console.log('Let\'s configure your AI providers.\n')

const envAnthropic = process.env.ANTHROPIC_API_KEY
const envOpenAI = process.env.OPENAI_API_KEY
const hasAuthAnthropic = !!auth.anthropic?.accessToken
const hasAuthOpenAI = !!auth.openai?.accessToken

let setupAnother = true
const configuredProviders: string[] = []

while (setupAnother) {
	console.log('Available providers:')
	console.log('  1) Anthropic (Claude)')
	console.log('  2) OpenAI (GPT, o-series)')
	console.log('  3) Skip')
	const choice = await askChoice('Which provider? [1/2/3]: ', ['1', '2', '3'])

	if (choice === '3') break

	if (choice === '1') {
		// Anthropic
		if (hasAuthAnthropic) {
			console.log('  ✓ Anthropic already configured (OAuth token in auth.ason)')
			configuredProviders.push('anthropic')
		} else if (envAnthropic) {
			console.log(`  Found ANTHROPIC_API_KEY in environment`)
			const use = await askChoice('  Use this key? [y/n]: ', ['y', 'n'])
			if (use === 'y') {
				auth.anthropic = { accessToken: envAnthropic }
				console.log('  ✓ Saved to auth.ason')
				configuredProviders.push('anthropic')
			}
		} else {
			console.log('  Options:')
			console.log('    1) Enter API key')
			console.log('    2) Login via OAuth (opens browser)')
			const method = await askChoice('  Method? [1/2]: ', ['1', '2'])
			if (method === '1') {
				const key = await ask('  API key: ')
				if (key.trim()) {
					auth.anthropic = { accessToken: key.trim() }
					console.log('  ✓ Saved to auth.ason')
					configuredProviders.push('anthropic')
				}
			} else {
				console.log('  Running login script...')
				rl.close()
				const p = Bun.spawn(['bun', `${HAL_DIR}/scripts/login-anthropic.ts`], { stdio: ['inherit', 'inherit', 'inherit'] })
				await p.exited
				process.exit(0)
			}
		}
	} else {
		// OpenAI
		if (hasAuthOpenAI) {
			console.log('  ✓ OpenAI already configured (OAuth token in auth.ason)')
			configuredProviders.push('openai')
		} else if (envOpenAI) {
			console.log(`  Found OPENAI_API_KEY in environment`)
			const use = await askChoice('  Use this key? [y/n]: ', ['y', 'n'])
			if (use === 'y') {
				auth.openai = { accessToken: envOpenAI }
				console.log('  ✓ Saved to auth.ason')
				configuredProviders.push('openai')
			}
		} else {
			console.log('  Options:')
			console.log('    1) Enter API key')
			console.log('    2) Login via OAuth (opens browser)')
			const method = await askChoice('  Method? [1/2]: ', ['1', '2'])
			if (method === '1') {
				const key = await ask('  API key: ')
				if (key.trim()) {
					auth.openai = { accessToken: key.trim() }
					console.log('  ✓ Saved to auth.ason')
					configuredProviders.push('openai')
				}
			} else {
				console.log('  Running login script...')
				rl.close()
				const p = Bun.spawn(['bun', `${HAL_DIR}/scripts/login-openai.ts`], { stdio: ['inherit', 'inherit', 'inherit'] })
				await p.exited
				process.exit(0)
			}
		}
	}

	const more = await askChoice('\nSet up another provider? [y/n]: ', ['y', 'n'])
	setupAnother = more === 'y'
}

// ── Permissions ──

console.log('\nPermission levels:')
console.log('  1) YOLO — no confirmation needed (fastest)')
console.log('  2) Ask for write operations (bash, write, edit)')
console.log('  3) Ask for all operations (including read, grep, ls)')
const perm = await askChoice('Choose [1/2/3]: ', ['1', '2', '3'])
const permMap: Record<string, string> = { '1': 'yolo', '2': 'ask-writes', '3': 'ask-all' }
;(config as any).permissions = permMap[perm]

// ── Default model ──

if (!config.defaultModel || configuredProviders.length > 0) {
	const hasAnthropic = hasAuthAnthropic || configuredProviders.includes('anthropic')
	const hasOpenAI = hasAuthOpenAI || configuredProviders.includes('openai')
	if (hasAnthropic && !config.defaultModel) {
		;(config as any).defaultModel = 'anthropic/claude-opus-4-6'
	}
	console.log(`\nDefault model: ${config.defaultModel}`)
}

// Save
;(config as any).save?.()
;(auth as any).save?.()

console.log(`\n✓ Setup complete!`)
console.log(`  config: ${CONFIG_PATH}`)
console.log(`  auth:   ${AUTH_PATH}`)
console.log(`\nRun ./run to start HAL.\n`)
rl.close()
