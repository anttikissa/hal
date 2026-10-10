import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { promptTemplate, type PromptRender } from './prompt-template.ts'

let root = ''
beforeEach(() => { root = mkdtempSync(`${tmpdir()}/hal-template-`) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
function render(text: string, vars: Record<string, string> = {}) {
	writeFileSync(`${root}/SYSTEM.md`, text)
	let problems: string[] = [], rendered: PromptRender = { sections: [] }
	return { text: promptTemplate.render(`${root}/SYSTEM.md`, vars, [], problems, rendered), problems, sections: rendered.sections }
}

test('nested matching fences select branches and render section headings without gaps', () => {
	let result = render('<!-- human -->\n:: if enabled="yes"\n::: section "Exact title" update="diff"\nfirst\n:::: if model="a*"\n  indented\n:::: else\nwrong\n::::\n::: \n::\n\n:: section "Empty"\n<!-- gone -->\n::\n\n:: section "Last"\nlast\n::', { enabled: 'yes', model: 'abc' })
	expect(result.problems).toEqual([])
	expect(result.text).toBe('# Exact title\nfirst\n  indented\n\n# Last\nlast')
	expect(result.sections.map((s) => [s.title, s.update, s.body])).toEqual([['Exact title', 'diff', 'first\n  indented'], ['Empty', 'full', ''], ['Last', 'full', 'last']])
	expect(render(':: if enabled="no"\n::: if model="abc"\nwrong\n::: else\nalso wrong\n:::\n::\nkept', { enabled: 'yes', model: 'abc' }).text).toBe('kept')
})

test('invalid fences, nested sections, duplicate titles and repeated else report precise errors', () => {
	for (let [text, error] of [
		[':: section "x"\nbody\n:::', 'expected 2'],
		[':: section "x"\n::: section "y"\n:::\n::', 'sections cannot nest'],
		[':: section "x"\n::\n:: section "x"\n::', 'duplicate section title'],
		[':: section ""\n::', 'section title is empty'],
		[':: if flag="yes"\n:: else\n:: else\n::', 'duplicate else'],
		[':: section "x"\nbody', 'unclosed section'],
		[':: section "x" update="auto"\n::', 'invalid directive'],
	] as const) expect(render(text, { flag: 'yes' }).problems.join('\n')).toContain(error)
	expect(render('<!-- first\nsecond\n-->\n:: section "x"\n:::').problems[0]).toContain('SYSTEM.md:5:')
})

test('literal loaded content preserves code whitespace and does not become template syntax', () => {
	let literal = ':: section "Pretend"\n  $model\n\n    code\n::'
	writeFileSync(`${root}/part.md`, literal)
	let result = render(':: section "Real"\n@part.md\n$agents\n::', { agents: literal, model: 'changed' })
	expect(result.problems).toEqual([])
	expect(result.text).toBe(`# Real\n${literal}\n${literal}`)
	expect(result.sections).toHaveLength(1)
})
