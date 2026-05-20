#!/usr/bin/env bun

// Manual, real-API benchmark for OpenAI Responses transport experiments.
//
// This intentionally is not part of ./test: it spends real OpenAI/ChatGPT quota
// and depends on live credentials. Today it measures the current HTTP/SSE path.
// After WebSocket support exists, run the same script with --mode=ws if the
// provider honors HAL_OPENAI_RESPONSES_TRANSPORT.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { performance } from 'perf_hooks'
import { openaiProvider, openai } from '../src/providers/openai.ts'
import { builtins } from '../src/tools/builtins.ts'
import { toolRegistry } from '../src/tools/tool.ts'
import type { ContentBlock, Message, TokenUsage, ToolDef } from '../src/protocol.ts'
import { ason } from '../src/utils/ason.ts'

interface Args {
	cycles: number
	runs: number
	model: string
	mode: string
	planPath: string
	outPath: string
	cwd: string
	strict: boolean
}

interface ToolRecord {
	turn: number
	index: number
	name: string
	ms: number
	ok: boolean
	inputPreview: string
	outputPreview: string
}

interface TurnRecord {
	turn: number
	ms: number
	firstEventMs: number | null
	firstTextMs: number | null
	textBytes: number
	toolCalls: number
	approxInputBytes: number
	usage?: TokenUsage
}

interface RunResult {
	mode: string
	model: string
	run: number
	cycles: number
	startedAt: string
	totalMs: number
	modelMs: number
	toolMs: number
	turns: TurnRecord[]
	tools: ToolRecord[]
	usage: TokenUsage
	approxSentBytes: number
	finalText: string
	ok: boolean
	error?: string
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		cycles: 10,
		runs: 1,
		model: 'gpt-5.5',
		mode: 'http',
		planPath: 'perf-test.md',
		outPath: '',
		cwd: process.cwd(),
		strict: true,
	}

	for (const raw of argv) {
		if (raw === '--help' || raw === '-h') {
			printUsage()
			process.exit(0)
		}
		const eq = raw.indexOf('=')
		const key = eq >= 0 ? raw.slice(0, eq) : raw
		const value = eq >= 0 ? raw.slice(eq + 1) : ''
		if (key === '--cycles') args.cycles = numberArg(key, value)
		else if (key === '--runs') args.runs = numberArg(key, value)
		else if (key === '--model') args.model = value
		else if (key === '--mode') args.mode = value
		else if (key === '--plan') args.planPath = value
		else if (key === '--out') args.outPath = value
		else if (key === '--cwd') args.cwd = resolve(value)
		else if (key === '--no-strict') args.strict = false
		else throw new Error(`Unknown argument: ${raw}`)
	}

	if (!['http', 'ws', 'auto'].includes(args.mode)) throw new Error('--mode must be http, ws, or auto')
	if (args.cycles < 1) throw new Error('--cycles must be >= 1')
	if (args.runs < 1) throw new Error('--runs must be >= 1')
	return args
}

function numberArg(name: string, value: string): number {
	const n = Number(value)
	if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`)
	return n
}

function printUsage(): void {
	writeStdout([
		'Usage:',
		'  bun scripts/openai-responses-transport-perf.ts --mode=http --cycles=10 --runs=3',
		'',
		'Options:',
		'  --mode=http|ws|auto   Transport label. Also sets HAL_OPENAI_RESPONSES_TRANSPORT for future provider code.',
		'  --cycles=N           Number of write/read cycles the model must perform. Default: 10.',
		'  --runs=N             Repetitions. Default: 1.',
		'  --model=MODEL        OpenAI model id without provider prefix. Default: gpt-5.5.',
		'  --plan=PATH          Model-visible plan file. Default: perf-test.md; generated if missing.',
		'  --out=PATH           Write ASON results to PATH.',
		'  --no-strict          Do not fail if the model batches or adds tool calls.',
	].join('\n') + '\n')
}

function writeStdout(text: string): void {
	process.stdout.write(text)
}

function writeStderr(text: string): void {
	process.stderr.write(text)
}

function defaultPlan(cycles: number): string {
	return [
		'# Hal OpenAI transport performance test',
		'',
		`Complete exactly ${cycles} cycles. Work through cycle 1, then cycle 2, and so on.`,
		'',
		'For each cycle N:',
		'1. Use the bash tool exactly once to write the file:',
		'   `printf "hello-N\\n" > /tmp/hal-openai-transport-perf-N.txt`',
		'2. Use the read tool exactly once to read that same file.',
		'3. Verify the file contains exactly `hello-N`.',
		'',
		'Rules:',
		'- Do not use cat, grep, glob, write, or any tools other than bash and read.',
		'- Do not batch multiple tool calls in one assistant message.',
		'- Do not skip any cycle.',
		'- After all cycles are complete, reply exactly: BENCHMARK_DONE',
	].join('\n') + '\n'
}

function ensurePlan(path: string, cycles: number): string {
	if (existsSync(path)) return readFileSync(path, 'utf8')
	const text = defaultPlan(cycles)
	writeFileSync(path, text, 'utf8')
	writeStdout(`Created ${path}; edit it if you want a different benchmark plan.\n`)
	return text
}

function selectTools(): ToolDef[] {
	builtins.init()
	const wanted = new Set(['bash', 'read'])
	return toolRegistry.toToolDefs().filter((tool) => wanted.has(tool.name))
}

function approxInputBytes(messages: Message[], systemPrompt: string, tools: ToolDef[]): number {
	return Buffer.byteLength(JSON.stringify({ messages, systemPrompt, tools }), 'utf8')
}

function preview(value: unknown, max = 180): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value)
	if (text.length <= max) return text
	return text.slice(0, max) + '…'
}

function usageZero(): TokenUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
}

function addUsage(total: TokenUsage, usage: TokenUsage | undefined): void {
	if (!usage) return
	total.input += usage.input
	total.output += usage.output
	total.cacheRead += usage.cacheRead
	total.cacheCreation += usage.cacheCreation
}

async function runOne(args: Args, run: number, plan: string, tools: ToolDef[]): Promise<RunResult> {
	const startedAt = new Date().toISOString()
	const sessionId = `perf-${Date.now().toString(36)}-${run}`
	const systemPrompt = [
		'You are running a latency benchmark. Follow the user plan exactly.',
		'Use only the provided tools. Do not explain intermediate steps.',
	].join('\n')
	const messages: Message[] = [{ role: 'user', content: plan }]
	const result: RunResult = {
		mode: args.mode,
		model: args.model,
		run,
		cycles: args.cycles,
		startedAt,
		totalMs: 0,
		modelMs: 0,
		toolMs: 0,
		turns: [],
		tools: [],
		usage: usageZero(),
		approxSentBytes: 0,
		finalText: '',
		ok: false,
	}

	const totalStart = performance.now()
	const maxTurns = args.cycles * 3 + 8
	let bashCalls = 0
	let readCalls = 0

	try {
		for (let turn = 1; turn <= maxTurns; turn++) {
			const turnStart = performance.now()
			const inputBytes = approxInputBytes(messages, systemPrompt, tools)
			result.approxSentBytes += inputBytes
			let firstEventMs: number | null = null
			let firstTextMs: number | null = null
			let assistantText = ''
			let thinkingText = ''
			let thinkingSignature = ''
			let usage: TokenUsage | undefined
			const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = []

			for await (const event of openaiProvider.generate({
				messages,
				model: args.model,
				systemPrompt,
				tools,
				sessionId,
			})) {
				if (firstEventMs == null) firstEventMs = performance.now() - turnStart
				if (event.type === 'text') {
					if (firstTextMs == null) firstTextMs = performance.now() - turnStart
					assistantText += event.text ?? ''
				} else if (event.type === 'thinking') {
					thinkingText += event.text ?? ''
				} else if (event.type === 'thinking_signature') {
					thinkingSignature = event.signature ?? ''
				} else if (event.type === 'tool_call') {
					toolCalls.push({ id: event.id ?? `call_${toolCalls.length}`, name: event.name ?? '', input: event.input ?? {} })
				} else if (event.type === 'error') {
					throw new Error(`${event.status ?? 'error'} ${event.message ?? ''} ${event.body ?? ''}`.trim())
				} else if (event.type === 'done') {
					usage = event.usage
				}
			}

			const turnMs = performance.now() - turnStart
			result.modelMs += turnMs
			addUsage(result.usage, usage)
			result.turns.push({
				turn,
				ms: Math.round(turnMs),
				firstEventMs: firstEventMs == null ? null : Math.round(firstEventMs),
				firstTextMs: firstTextMs == null ? null : Math.round(firstTextMs),
				textBytes: Buffer.byteLength(assistantText, 'utf8'),
				toolCalls: toolCalls.length,
				approxInputBytes: inputBytes,
				usage,
			})

			if (toolCalls.length === 0) {
				result.finalText = assistantText.trim()
				result.ok = result.finalText === 'BENCHMARK_DONE' && bashCalls === args.cycles && readCalls === args.cycles
				if (!result.ok) {
					result.error = `unexpected final state: text=${JSON.stringify(result.finalText)}, bash=${bashCalls}, read=${readCalls}`
				}
				break
			}

			if (args.strict && toolCalls.length !== 1) {
				throw new Error(`strict mode expected exactly 1 tool call on turn ${turn}, got ${toolCalls.length}`)
			}

			const assistantContent: ContentBlock[] = []
			if (thinkingText && thinkingSignature) assistantContent.push({ type: 'thinking', thinking: thinkingText, signature: thinkingSignature })
			if (assistantText) assistantContent.push({ type: 'text', text: assistantText })

			for (let i = 0; i < toolCalls.length; i++) {
				const call = toolCalls[i]!
				if (call.name !== 'bash' && call.name !== 'read') throw new Error(`unexpected tool: ${call.name}`)
				if (call.name === 'bash') bashCalls++
				if (call.name === 'read') readCalls++
				assistantContent.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
			}
			messages.push({ role: 'assistant', content: assistantContent })

			for (let i = 0; i < toolCalls.length; i++) {
				const call = toolCalls[i]!
				const toolStart = performance.now()
				const output = await toolRegistry.dispatch(call.name, call.input, { sessionId, cwd: args.cwd, approvedRisk: true })
				const toolMs = performance.now() - toolStart
				result.toolMs += toolMs
				result.tools.push({
					turn,
					index: i,
					name: call.name,
					ms: Math.round(toolMs),
					ok: !output.startsWith('error:'),
					inputPreview: preview(call.input),
					outputPreview: preview(output),
				})
				messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: output }] })
			}
		}
	} catch (err) {
		result.error = err instanceof Error ? err.message : String(err)
	} finally {
		result.totalMs = Math.round(performance.now() - totalStart)
		result.modelMs = Math.round(result.modelMs)
		result.toolMs = Math.round(result.toolMs)
	}

	return result
}

function summarize(results: RunResult[]): Record<string, unknown> {
	const ok = results.filter((result) => result.ok)
	return {
		runs: results.length,
		ok: ok.length,
		failed: results.length - ok.length,
		totalMs: stats(ok.map((result) => result.totalMs)),
		modelMs: stats(ok.map((result) => result.modelMs)),
		toolMs: stats(ok.map((result) => result.toolMs)),
		turns: stats(ok.map((result) => result.turns.length)),
		toolCalls: stats(ok.map((result) => result.tools.length)),
	}
}

function stats(values: number[]): Record<string, number | null> {
	if (values.length === 0) return { min: null, median: null, p90: null, max: null }
	const sorted = [...values].sort((a, b) => a - b)
	return {
		min: sorted[0]!,
		median: percentile(sorted, 0.5),
		p90: percentile(sorted, 0.9),
		max: sorted[sorted.length - 1]!,
	}
}

function percentile(sorted: number[], p: number): number {
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
	return sorted[index]!
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	process.env.HAL_OPENAI_RESPONSES_TRANSPORT = args.mode
	const plan = ensurePlan(args.planPath, args.cycles)
	const tools = selectTools()
	const results: RunResult[] = []

	writeStdout(`Starting OpenAI Responses transport perf: mode=${args.mode}, model=${args.model}, cycles=${args.cycles}, runs=${args.runs}\n`)
	for (let run = 1; run <= args.runs; run++) {
		writeStdout(`Run ${run}/${args.runs}...\n`)
		const result = await runOne(args, run, plan, tools)
		results.push(result)
		writeStdout(`  ${result.ok ? 'ok' : 'failed'} total=${result.totalMs}ms model=${result.modelMs}ms tool=${result.toolMs}ms tools=${result.tools.length}\n`)
		if (result.error) writeStdout(`  error=${result.error}\n`)
	}

	const report = { args, summary: summarize(results), results }
	const text = ason.stringify(report) + '\n'
	if (args.outPath) {
		const dir = resolve(args.outPath, '..')
		if (dir && dir !== args.outPath) mkdirSync(dir, { recursive: true })
		writeFileSync(args.outPath, text, 'utf8')
		writeStdout(`Wrote ${args.outPath}\n`)
	} else {
		writeStdout(text)
	}

	openai.resetResponsesWebSocketsForTests()
	if (results.some((result) => !result.ok)) process.exitCode = 1
}

main().catch((err) => {
	writeStderr(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
	process.exit(1)
})
