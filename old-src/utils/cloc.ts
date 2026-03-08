/** Count source files and code lines (excluding blanks and comments), matching cloc output. */
export async function countSourceStats(dir: string): Promise<{ files: number; lines: number }> {
	let files = 0
	let code = 0
	const countFile = async (path: string) => {
		files++
		const content = await Bun.file(path).text()
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
			code++
		}
	}
	const glob = new Bun.Glob('**/*.ts')
	for await (const path of glob.scan({ cwd: `${dir}/src`, onlyFiles: true })) {
		if (path.endsWith('.test.ts') || path.startsWith('tests/')) continue
		await countFile(`${dir}/src/${path}`)
	}

	await countFile(`${dir}/main.ts`)
	return { files, lines: code }
}
