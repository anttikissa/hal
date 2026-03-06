#!/usr/bin/env bun
// Count non-comment, non-test, non-blank lines under new/

const dir = import.meta.dir + '/../new'
const result = '/tmp/new-cloc.txt'

let lines = 0
const glob = new Bun.Glob('*.ts')
for await (const path of glob.scan({ cwd: dir, onlyFiles: true })) {
	if (path.endsWith('.test.ts')) continue
	const content = await Bun.file(`${dir}/${path}`).text()
	let inBlock = false
	for (const line of content.split('\n')) {
		const t = line.trim()
		if (inBlock) { if (t.includes('*/')) inBlock = false; continue }
		if (!t || t.startsWith('//')) continue
		if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue }
		lines++
	}
}

let prev: number | null = null
try { prev = parseInt(await Bun.file(result).text(), 10) } catch {}

await Bun.write(result, String(lines))

if (prev !== null && prev !== lines) {
	const delta = lines - prev
	const sign = delta > 0 ? '+' : ''
	const msg = delta < 0 ? `${sign}${delta} lines! Nice!` : `${sign}${delta} lines`
	console.log(`new/ ${lines} LOC (${msg})`)
} else {
	console.log(`new/ ${lines} LOC`)
}
