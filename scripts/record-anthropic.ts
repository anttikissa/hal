// Records real Anthropic SSE streams for src/e2e.test.ts's fake server:
// a text reply and a tool call. Run by hand: bun scripts/record-anthropic.ts
import { writeFileSync } from 'fs'
import { anthropic } from '../src/host/anthropic.ts'
import { nativeTool } from '../src/host/native-tool.ts'

const dir = `${import.meta.dir}/../src/fixtures`
const model = 'claude-opus-5-5'

async function record(file: string, prompt: string): Promise<void> {
	let req = { model, maxTokens: 2000, system: 'You are a test fixture. Follow the user literally.', tools: [nativeTool.def()], messages: [{ role: 'user' as const, blocks: [{ type: 'text' as const, text: prompt }] }] }
	let { url, headers, body } = await anthropic.request(req)
	let res = await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
	let text = await res.text()
	if (!res.ok) throw new Error(`${res.status} ${text}`)
	writeFileSync(`${dir}/${file}`, text)
}

await record('anthropic-text.sse', 'Reply with exactly the word HELLO and nothing else. Do not call tools.')
await record('anthropic-tool.sse', 'Call the tool once with cmd set to exactly: BASH "echo hi"')
