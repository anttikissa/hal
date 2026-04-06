#!/usr/bin/env bun
// Quick script to add API keys to auth.ason.
// Usage:
//   bun scripts/add-keys.ts                  # interactive prompts
//   bun scripts/add-keys.ts anthropic sk-... # set directly
//   bun scripts/add-keys.ts openai sk-...    # set directly

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { ason } from '../src/utils/ason.ts'

const AUTH_PATH = import.meta.dir + '/../auth.ason'

// Load existing auth or start fresh
let auth: Record<string, any> = {}
if (existsSync(AUTH_PATH)) {
	try { auth = ason.parse(readFileSync(AUTH_PATH, 'utf-8')) as any } catch {}
}

function save() {
	writeFileSync(AUTH_PATH, ason.stringify(auth) + '\n')
	console.log(`Saved to ${AUTH_PATH}`)
}

// Direct mode: bun scripts/add-keys.ts <provider> <key>
const [provider, key] = process.argv.slice(2)
if (provider && key) {
	const name = provider.toLowerCase()
	if (!['anthropic', 'openai', 'serper'].includes(name)) {
		console.error(`Unknown provider: ${name}. Use 'anthropic', 'openai', or 'serper'.`)
		process.exit(1)
	}
	auth[name] = { ...auth[name], apiKey: key }
	save()
	console.log(`${name} API key set.`)
	process.exit(0)
}

// Interactive mode
console.log('Add API keys to auth.ason\n')
console.log('Leave blank to skip.\n')

const anthropicKey = prompt('Anthropic API key:')
if (anthropicKey?.trim()) {
	auth.anthropic = { ...auth.anthropic, apiKey: anthropicKey.trim() }
	console.log('  ✓ Anthropic key set')
}

const openaiKey = prompt('OpenAI API key:')
if (openaiKey?.trim()) {
	auth.openai = { ...auth.openai, apiKey: openaiKey.trim() }
	console.log('  ✓ OpenAI key set')
}

const serperKey = prompt('Serper API key (serper.dev):')
if (serperKey?.trim()) {
	auth.serper = { ...auth.serper, apiKey: serperKey.trim() }
	console.log('  ✓ Serper key set')
}

if (anthropicKey?.trim() || openaiKey?.trim() || serperKey?.trim()) {
	save()
} else {
	console.log('\nNo keys entered.')
}
