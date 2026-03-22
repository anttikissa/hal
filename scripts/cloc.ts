#!/usr/bin/env bun
// Count non-comment, non-test, non-blank lines per module under src/

const dir = import.meta.dir + '/../src'
const result = '/tmp/new-cloc.txt'

const counts: [string, number][] = []
let total = 0
let totalBytes = 0
const glob = new Bun.Glob('**/*.ts')
for await (const path of glob.scan({ cwd: dir, onlyFiles: true })) {
	if (
		path.endsWith('.test.ts') ||
		path.startsWith('test') ||
		path.startsWith('tests/') ||
		path.startsWith('utils/')
	)
		continue
	const content = await Bun.file(`${dir}/${path}`).text()
	let lines = 0
	let inBlock = false
	for (const line of content.split('\n')) {
		const t = line.trim()
		if (inBlock) {
			if (t.includes('*/')) inBlock = false
			continue
		}
		if (!t || t.startsWith('//')) continue
		if (t.startsWith('/*')) {
			if (!t.includes('*/')) inBlock = true
			continue
		}
		lines++
	}
	counts.push([path, lines])
	total += lines
	totalBytes += Buffer.byteLength(content, 'utf8')
}

counts.sort((a, b) => b[1] - a[1])

let prev: number | null = null
try {
	prev = parseInt(await Bun.file(result).text(), 10)
} catch {}

await Bun.write(result, String(total))

const pad = Math.max(...counts.map(([, n]) => String(n).length))
for (const [name, n] of counts) {
	console.log(`  ${String(n).padStart(pad)}  ${name}`)
}

const kb = (totalBytes / 1024).toFixed(1)
if (prev !== null && prev !== total) {
	const delta = total - prev
	const sign = delta > 0 ? '+' : ''
	const msg =
		delta < 0 ? `${sign}${delta} lines! Nice!` : `${sign}${delta} lines`
	console.log(`  ${String(total).padStart(pad)}  total (${msg}) — ${kb} KB`)
} else {
	console.log(`  ${String(total).padStart(pad)}  total — ${kb} KB`)
}
