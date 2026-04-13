import { afterEach, expect, test } from 'bun:test'
import { commands, type SessionState } from './commands.ts'
import { inbox } from './inbox.ts'
import { config } from '../config.ts'
import { agentLoop } from './agent-loop.ts'
import { openaiUsage } from '../openai-usage.ts'
import { memory } from '../memory.ts'
import { models } from '../models.ts'

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
const sent: Array<{ sessionId: string; text: string; from?: string }> = []
const origQueueMessage = inbox.queueMessage
const origConfigData = config.data
const origConfigSave = config.save
const origMaxIterations = agentLoop.config.maxIterations
const origRenderStatus = openaiUsage.renderStatus
const origMemoryConfig = { ...memory.config }
const origReadRss = memory.io.readRss
const origDefaultModel = models.config.default

function makeSession(id = '04-aaa'): SessionState {
	return {
		id,
		name: 'tab 1',
		cwd: process.cwd(),
		createdAt: new Date().toISOString(),
		sessions: [
			{ id: '04-aaa', name: 'tab 1' },
			{ id: '04-bbb', name: 'tab 2' },
			{ id: '04-ccc', name: 'tab 3' },
		],
	}
}

function stubConfigData(data: Record<string, any> = {}): void {
	config.data = data
	config.save = () => {}
}

afterEach(() => {
	sent.length = 0
	inbox.queueMessage = origQueueMessage
	config.data = origConfigData
	config.save = origConfigSave
	agentLoop.config.maxIterations = origMaxIterations
	openaiUsage.renderStatus = origRenderStatus
	Object.assign(memory.config, origMemoryConfig)
	memory.io.readRss = origReadRss
	models.config.default = origDefaultModel
})

test('/send resolves a tab number', async () => {
	inbox.queueMessage = (sessionId, text, from) => {
		sent.push({ sessionId, text, from })
	}

	const result = await commands.executeCommand('/send 2 hello there', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('04-bbb')
	expect(sent).toEqual([{ sessionId: '04-bbb', text: 'hello there', from: '04-aaa' }])
})

test('/send resolves a session id', async () => {
	inbox.queueMessage = (sessionId, text, from) => {
		sent.push({ sessionId, text, from })
	}

	const result = await commands.executeCommand('/send 04-ccc hello', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(sent).toEqual([{ sessionId: '04-ccc', text: 'hello', from: '04-aaa' }])
})

test('/broadcast sends to every other session', async () => {
	inbox.queueMessage = (sessionId, text, from) => {
		sent.push({ sessionId, text, from })
	}

	const result = await commands.executeCommand('/broadcast hello all', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('2 session')
	expect(sent).toEqual([
		{ sessionId: '04-bbb', text: 'hello all', from: '04-aaa' },
		{ sessionId: '04-ccc', text: 'hello all', from: '04-aaa' },
	])
})

test('/send rejects an unknown tab number', async () => {
	const result = await commands.executeCommand('/send 99 hello', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.output).toBeUndefined()
	expect(result.error).toContain('99')
	expect(sent).toEqual([])
})


test('/status renders OpenAI subscription usage', async () => {
	openaiUsage.renderStatus = async () => 'OpenAI subscriptions:\n* 1/2 a@test.com · 5h 23% used'

	const result = await commands.executeCommand('/status', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('OpenAI subscriptions:')
	expect(result.output).toContain('5h 23% used')
})


test('/usage is an alias for /status', async () => {
	openaiUsage.renderStatus = async () => 'alias ok'

	const result = await commands.executeCommand('/usage', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toBe('alias ok')
})


test('/mem shows current rss and thresholds', async () => {
	memory.io.readRss = () => 1_234_000_000
	memory.config.warnBytes = 1_500_000_000
	memory.config.killBytes = 0

	const result = await commands.executeCommand('/mem', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('Memory:')
	expect(result.output).toContain('Current: 1.23 GB RSS')
	expect(result.output).toContain('Warn: 1.50 GB RSS')
	expect(result.output).toContain('Kill: disabled')
})

test('/help config shows config caveats and syntax', async () => {
	const result = await commands.executeCommand('/help config', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('/config <module-or-path> <value>')
	expect(result.output).toContain('reload can replace temp values')
})

test('/help /config accepts a leading slash', async () => {
	const result = await commands.executeCommand('/help /config', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('/config --temp <module-or-path> <value>')
})

test('/help model shows layered help for another command', async () => {
	const result = await commands.executeCommand('/help model', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('Usage: /model [name]')
})

test('/config --help reuses detailed config help', async () => {
	const result = await commands.executeCommand('/config --help', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('Caveat:')
})

test('/config shows current live config', async () => {
	stubConfigData()
	const result = await commands.executeCommand('/config', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('Current config:')
	expect(result.output).toContain('agentLoop')
	expect(result.output).toContain('maxIterations')
})

test('/config path shows one live value', async () => {
	stubConfigData()
	const result = await commands.executeCommand('/config agentLoop.maxIterations', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('agentLoop.maxIterations:')
	expect(result.output).toContain(String(agentLoop.config.maxIterations))
})

test('/config sets a temp value with --temp at the end', async () => {
	stubConfigData()
	const result = await commands.executeCommand('/config agentLoop.maxIterations 2 --temp', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('Temporarily set agentLoop.maxIterations = 2')
	expect(agentLoop.config.maxIterations).toBe(2)
})

test('/config sets a temp value with --temp before the path', async () => {
	stubConfigData()
	const result = await commands.executeCommand('/config --temp agentLoop.maxIterations 3', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('Temporarily set agentLoop.maxIterations = 3')
	expect(agentLoop.config.maxIterations).toBe(3)
})

test('/config writes a persistent override and applies it now', async () => {
	stubConfigData({ agentLoop: {} })
	const result = await commands.executeCommand('/config agentLoop.maxIterations 7', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('Set agentLoop.maxIterations = 7')
	expect(config.data.agentLoop.maxIterations).toBe(7)
	expect(agentLoop.config.maxIterations).toBe(7)
})

test('/config accepts a bare string value', async () => {
	stubConfigData({ models: {} })
	const result = await commands.executeCommand('/config models.default gpt', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain("Set models.default = 'gpt'")
	expect(config.data.models.default).toBe('gpt')
	expect(models.config.default).toBe('gpt')
})

test('/show config points to /config instead of duplicating it', async () => {
	const result = await commands.executeCommand('/show config', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('/config')
	expect(result.output).not.toContain('Config overrides:')
})

test('/show with no topic points to /system', async () => {
	const result = await commands.executeCommand('/show', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('/system')
})


test('/system reflects updated prompt files', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-system-test-'))
	const origHalDir = process.env.HAL_DIR
	try {
		process.env.HAL_DIR = dir
		writeFileSync(join(dir, 'SYSTEM.md'), 'first\n')
		const cwd = join(dir, 'repo')
		mkdirSync(join(cwd, '.git'), { recursive: true })
		writeFileSync(join(cwd, 'AGENTS.md'), 'agent one\n')
		const session = makeSession()
		session.cwd = cwd

		const first = await commands.executeCommand('/system', session, () => {})
		expect(first.output).toContain('first')
		expect(first.output).toContain('agent one')

		writeFileSync(join(dir, 'SYSTEM.md'), 'second\n')
		writeFileSync(join(cwd, 'AGENTS.md'), 'agent two\n')

		const second = await commands.executeCommand('/system', session, () => {})
		expect(second.output).toContain('second')
		expect(second.output).toContain('agent two')
	} finally {
		if (origHalDir === undefined) delete process.env.HAL_DIR
		else process.env.HAL_DIR = origHalDir
		rmSync(dir, { recursive: true, force: true })
	}
})


test('/model with an explicit target requests a restart while busy', async () => {
	const session = makeSession()
	const result = await commands.executeCommand('/model gpt-5.4', session, () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.output).toContain('Model set to GPT 5.4')
	expect(result.restartGeneration).toBe(true)
})

test('/model with no target only lists models', async () => {
	const result = await commands.executeCommand('/model', makeSession(), () => {})

	expect(result.handled).toBe(true)
	expect(result.error).toBeUndefined()
	expect(result.restartGeneration).toBeUndefined()
})
