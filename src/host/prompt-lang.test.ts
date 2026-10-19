import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { promptLang, type PromptRender } from './prompt-lang.ts'

let root = ''
beforeEach(() => {
	root = mkdtempSync(`${tmpdir()}/hal-template-`)
})
afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})
function render(text: string, vars: Record<string, string> = {}) {
	writeFileSync(`${root}/SYSTEM.md`, text)
	let problems: string[] = [],
		rendered: PromptRender = { sections: [] }
	return {
		text: promptLang.render(`${root}/SYSTEM.md`, vars, [], problems, rendered),
		problems,
		sections: rendered.sections,
	}
}

test('nested matching fences select branches and render section headings without gaps', () => {
	let result = render(
		'<!-- human -->\n:: if $enabled == "yes"\n::: section "Exact title" update="diff"\nfirst\n:::: if $model like "a*"\n  indented\n:::: else\nwrong\n::::\n::: \n::\n\n:: section "Empty"\n<!-- gone -->\n::\n\n:: section "Last"\nlast\n::',
		{ enabled: 'yes', model: 'abc' },
	)
	expect(result.problems).toEqual([])
	expect(result.text).toBe('# Exact title\nfirst\n  indented\n\n# Last\nlast')
	expect(result.sections.map((s) => [s.title, s.update, s.body])).toEqual([
		['Exact title', 'diff', 'first\n  indented'],
		['Empty', 'full', ''],
		['Last', 'full', 'last'],
	])
	expect(
		render(':: if $enabled == "no"\n::: if $model == "abc"\nwrong\n::: else\nalso wrong\n:::\n::\nkept', {
			enabled: 'yes',
			model: 'abc',
		}).text,
	).toBe('kept')
	expect(
		render('<!-- outer <!-- inner --> leaked -->\n<!-- open').problems.map((p) => p.replace(/.*:(\d+): /, '$1: ')),
	).toEqual(['1: stray --> (comments do not nest)', '2: unclosed <!--'])
})

test('if compares with == and like, joins with && and rejects the old key="value" form', () => {
	let vars = { cwd: '~/.hal', src: '~/.hal', sub: '~/.hal/src' }
	let pick = (condition: string) => render(`:: if ${condition}\nyes\n:: else\nno\n::`, vars)
	expect(pick('$cwd == $src').text).toBe('yes')
	expect(pick('$sub == $src').text).toBe('no')
	expect(pick('$sub like "~/.hal/*"').text).toBe('yes')
	expect(pick('$sub == "~/.hal/*"').text).toBe('no')
	expect(pick('$cwd == $src && ${sub} like "*src"').text).toBe('yes')
	expect(pick('$cwd == $src && $sub == "x"').text).toBe('no')
	expect(pick('$cwd == "a && b"').problems).toEqual([])
	expect(pick('$cwd == $nope').problems.join('\n')).toContain('unknown key nope')
	expect(pick('cwd="~/.hal"').problems.join('\n')).toContain('invalid if directive; use $key, !$key')
	expect(pick('$sub != $src').text).toBe('yes')
	expect(pick('$cwd = $src').problems.join('\n')).toContain('invalid if directive')
	expect(pick('$cwd == true').problems.join('\n')).toContain('invalid if directive')
})

test('bare if $x is false only for empty, 0, false, no and off; ! negates', () => {
	for (let [value, expected] of [
		['', 'no'],
		['0', 'no'],
		['False', 'no'],
		['no', 'no'],
		['off', 'no'],
		['true', 'yes'],
		['3', 'yes'],
		['-1', 'yes'],
		['01-abc', 'yes'],
	] as const) {
		expect(render(':: if $x\nyes\n:: else\nno\n::', { x: value }).text).toBe(expected)
		expect(render(':: if !$x\nno\n:: else\nyes\n::', { x: value }).text).toBe(expected)
	}
	expect(render(':: if $a && !$b\nyes\n::', { a: '2', b: '' }).text).toBe('yes')
})

test('invalid fences, nested sections, duplicate titles and repeated else report precise errors', () => {
	for (let [text, error] of [
		[':: section "x"\nbody\n:::', 'expected 2'],
		[':: section "x"\n::: section "y"\n:::\n::', 'sections cannot nest'],
		[':: section "x"\n::\n:: section "x"\n::', 'duplicate section title'],
		[':: section ""\n::', 'section title is empty'],
		[':: if $flag == "yes"\n:: else\n:: else\n::', 'duplicate else'],
		[':: section "x"\nbody', 'unclosed section'],
		[':: section "x" update="auto"\n::', 'invalid directive'],
	] as const)
		expect(render(text, { flag: 'yes' }).problems.join('\n')).toContain(error)
	expect(render('<!-- first\nsecond\n-->\n:: section "x"\n:::').problems[0]).toContain('SYSTEM.md:5:')
})

test('includes render as templates while $agents stays literal', () => {
	let literal = ':: section "Pretend"\n  $model\n\n    code\n::'
	writeFileSync(`${root}/part.md`, '<!-- note -->\n:: if $model like "c*"\n  $model\n:: else\nwrong\n::\n@part.md')
	let result = render(':: section "Real"\n@part.md\n$agents\n::', { agents: literal, model: 'changed' })
	expect(result.problems.join()).toMatch(/part\.md:7: include cycle/)
	expect(result.text).toBe(`# Real\n  changed\n${literal}`)
	expect(result.sections).toHaveLength(1)
	expect(render('@part.md\nkept', { model: 'x' }).problems).toEqual([
		`${root}/part.md:7: include cycle: ${root}/part.md`,
	])
	writeFileSync(`${root}/part.md`, ':: if $model == "x"\nopen')
	expect(render('@part.md\n::\nafter', { model: 'x' }).problems).toEqual([
		`${root}/part.md:1: unclosed if block`,
		`${root}/SYSTEM.md:2: unexpected closing directive`,
	])
})
