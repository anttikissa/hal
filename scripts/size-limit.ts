#!/usr/bin/env bun
// Source files stay under a token budget (bytes / 4) so an agent can read
// each one whole. conventions.test.ts checks all of src/; run with --staged
// (the pre-commit hook) to check only staged files.

const maxBytes = 20_000 // about 5,000 tokens

// src-relative paths allowed to exceed the limit, with the reason.
const exceptions: Record<string, string> = {
	'common/ason.ts': 'self-contained format: parser and stringifier belong together',
}

const advice = `How to split:
- Source: move one coherent responsibility into its own module, named for
  that responsibility (history.ts -> history-index.ts). Callers import the
  new module directly. The old module does not re-export it.
- Tests: split by feature area into <module>-<area>.test.ts. Move shared
  fixtures to a test helper module.
- Do not shrink a file by squeezing formatting or deleting comments or
  tests.
- A self-contained file may get an exception with a reason in
  scripts/size-limit.ts.`

// Whether the size rule covers a src-relative path.
function covers(rel: string): boolean {
	return /\.tsx?$/.test(rel)
}

// sizes maps src-relative paths to byte counts. Returns one message per
// oversized unlisted file and per listed file that is small or missing.
function problems(sizes: Record<string, number>, all = true): string[] {
	let out: string[] = []
	for (let [rel, n] of Object.entries(sizes)) {
		if (n > maxBytes && !(rel in exceptions))
			out.push(`src/${rel} is ${n} bytes, about ${Math.round(n / 4)} tokens (max ${maxBytes} bytes)`)
	}
	if (!all) return out
	for (let rel of Object.keys(exceptions)) {
		if (!(rel in sizes)) out.push(`src/${rel} is listed as an exception but does not exist`)
		else if (sizes[rel]! <= maxBytes) out.push(`src/${rel} is listed as an exception but has only ${sizes[rel]} bytes`)
	}
	return out
}

// Sizes of the staged versions of covered src/ files.
function stagedSizes(): Record<string, number> {
	let git = (...args: string[]) => Bun.spawnSync(['git', ...args]).stdout.toString()
	let sizes: Record<string, number> = {}
	for (let path of git('diff', '--cached', '--name-only', '--diff-filter=ACMR').split('\n')) {
		if (!path.startsWith('src/') || !covers(path)) continue
		sizes[path.slice(4)] = Number(git('cat-file', '-s', `:${path}`).trim())
	}
	return sizes
}

export const sizeLimit = { maxBytes, exceptions, advice, covers, problems }

if (import.meta.main && process.argv.includes('--staged')) {
	let found = problems(stagedSizes(), false)
	if (found.length) {
		console.error(`Files over the size limit:\n${found.map((p) => `  ${p}`).join('\n')}\n\n${advice}`)
		process.exit(1)
	}
}
