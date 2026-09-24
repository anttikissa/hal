import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// The web app is a fixed tab strip, a scrolling transcript and a fixed composer.
// That only works if the element that establishes the viewport-filling flex column
// is the very element the app mounts into: any wrapper in between turns the rows
// into ordinary blocks and nothing scrolls at all (regression in ccf5df8).
// We have no layout engine in tests, so we assert that parent chain instead.

const webDir = resolve(import.meta.dirname, '../src/web-client')

type CssRule = { selector: string, decls: Map<string, string> }

// Minimal top-level CSS rule reader: enough for our single flat stylesheet.
// At-rules (@media, @keyframes) are skipped whole; we only assert on base rules.
function parseTopLevelRules(css: string): CssRule[] {
	const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
	const rules: CssRule[] = []
	let index = 0
	while (index < source.length) {
		const open = source.indexOf('{', index)
		if (open < 0) break
		const selector = source.slice(index, open).trim()
		let depth = 1
		let cursor = open + 1
		while (cursor < source.length && depth > 0) {
			if (source[cursor] === '{') depth++
			if (source[cursor] === '}') depth--
			cursor++
		}
		if (!selector.startsWith('@')) rules.push({ selector, decls: parseDecls(source.slice(open + 1, cursor - 1)) })
		index = cursor
	}
	return rules
}

function parseDecls(body: string): Map<string, string> {
	const decls = new Map<string, string>()
	for (const part of body.split(';')) {
		const colon = part.indexOf(':')
		if (colon < 0) continue
		decls.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim())
	}
	return decls
}

function rulesFor(selector: string): CssRule[] {
	const css = readFileSync(resolve(webDir, 'styles.css'), 'utf8')
	return parseTopLevelRules(css).filter((rule) => rule.selector === selector)
}

function declaration(selector: string, property: string): string | undefined {
	for (const rule of rulesFor(selector)) {
		const value = rule.decls.get(property)
		if (value !== undefined) return value
	}
	return undefined
}

function rulesInside(atRule: string): CssRule[] {
	const css = readFileSync(resolve(webDir, 'styles.css'), 'utf8')
	const start = css.indexOf(atRule)
	if (start < 0) return []
	const open = css.indexOf('{', start)
	let depth = 1
	let cursor = open + 1
	while (cursor < css.length && depth > 0) {
		if (css[cursor] === '{') depth++
		if (css[cursor] === '}') depth--
		cursor++
	}
	return parseTopLevelRules(css.slice(open + 1, cursor - 1))
}

function declarationInside(atRule: string, selector: string, property: string): string | undefined {
	return rulesInside(atRule).find((rule) => rule.selector === selector)?.decls.get(property)
}

// The selector main.tsx renders into, which index.html must provide.
function mountSelector(): string {
	const main = readFileSync(resolve(webDir, 'main.tsx'), 'utf8')
	const match = main.match(/document\.querySelector\('([^']+)'\)/)
	if (!match?.[1]) throw new Error('main.tsx does not mount into a selector')
	return match[1]
}

test('index.html provides the element the app mounts into', () => {
	const selector = mountSelector()
	expect(selector.startsWith('#')).toBe(true)
	expect(readFileSync(resolve(webDir, 'index.html'), 'utf8')).toContain(`id="${selector.slice(1)}"`)
})

test('the rows are rendered directly into the mount element', () => {
	const main = readFileSync(resolve(webDir, 'main.tsx'), 'utf8')
	// The rows must be siblings in a fragment. Solid renders `<>` and `<Show>`
	// without a host element, so they reach #app as its own children; any real
	// element around them would re-introduce the ccf5df8 wrapper.
	const fragment = main.match(/return <>([\s\S]*?)<\/>/)
	if (!fragment?.[1]) throw new Error('main.tsx does not render the rows as a fragment')
	const rows = fragment[1]
	for (const row of ['<SessionTabs', '<Transcript', '<PromptComposer']) expect(rows).toContain(row)
	// Lowercase tag names are host elements; components are capitalised.
	expect(rows.match(/<[a-z][a-zA-Z-]*[\s/>]/)).toBeNull()
})

test('the viewport-filling flex column is the mount element itself', () => {
	const css = readFileSync(resolve(webDir, 'styles.css'), 'utf8')
	const columns = parseTopLevelRules(css).filter((rule) => {
		return rule.decls.get('display') === 'flex' && rule.decls.get('flex-direction') === 'column' && rule.decls.get('height')?.includes('dvh')
	})
	// Exactly one element fills the viewport and lays the rows out, and it is the
	// mount element, so no wrapper can ever come between it and the rows.
	expect(columns.map((rule) => rule.selector)).toEqual([mountSelector()])
	expect(columns[0]?.decls.get('overflow')).toBe('hidden')
})

test('the transcript is the only scrolling row', () => {
	expect(declaration('.Transcript', 'flex')).toBe('1')
	// A flex child only scrolls if it may shrink below its content height.
	expect(declaration('.Transcript', 'min-height')).toBe('0')
	expect(declaration('.Transcript', 'overflow-y')).toBe('auto')
	expect(declaration('.SessionTabs', 'flex')).toBe('none')
	expect(declaration('.PromptComposer', 'flex')).toBe('none')
})

test('idle composer activity uses the palette idle grey instead of the done-tab green', () => {
	expect(declaration('.PromptComposer-activity', 'color')).toBe('var(--assistant-cursorIdle, var(--status-fg, var(--muted)))')
})

test('accepted messages force the transcript to its bottom even if the reader scrolled up', () => {
	const main = readFileSync(resolve(webDir, 'main.tsx'), 'utf8')
	const transcript = readFileSync(resolve(webDir, 'components/Transcript.tsx'), 'utf8')
	expect(main).toContain('setSendCount((count) => count + 1)')
	expect(main).toContain('sendCount={sendCount()}')
	expect(transcript).toContain('webScroll.toBottom(element)')
	expect(transcript).toContain('() => props.sendCount')
})

test('native motion is only requested for new blocks or sends and respects reduced motion', () => {
	const transcript = readFileSync(resolve(webDir, 'components/Transcript.tsx'), 'utf8')
	expect(transcript).toContain('items.length > lastCount')
	expect(transcript).toContain("matchMedia('(prefers-reduced-motion: reduce)').matches")
	expect(transcript).toContain('onScrollEnd=')
})

test('prompt type stays readable without triggering iOS focus zoom', () => {
	expect(declaration('.PromptComposer > textarea', 'font-size')).toBe('16px')
	expect(declaration('.PromptComposer > textarea', 'line-height')).toBe('24px')
})

test('composer controls use CSS borders rather than native control decoration', () => {
	const controls = '.PromptComposer > textarea, .PromptComposer-controls > button'
	expect(declaration(controls, 'appearance')).toBe('none')
	expect(declaration(controls, 'margin')).toBe('0')
	expect(declaration(controls, 'border-radius')).toBe('0')
	expect(declaration(controls, 'box-shadow')).toBe('none')
	expect(declaration('.PromptComposer', 'align-items')).toBe('stretch')
	expect(declaration('.PromptComposer > .PromptComposer-controls', 'align-items')).toBe('stretch')
})

test('short composer buttons fit within the same 44px minimum as the textarea', () => {
	const buttons = '.PromptComposer-controls > button'
	expect(declaration(buttons, 'min-height')).toBe(declaration('.PromptComposer > textarea', 'min-height'))
	// An explicit 24px line box bounds Apple Color Emoji within the touch target.
	expect(declaration(buttons, 'line-height')).toBe('24px')
})

test('single-line prompt text has equal space above and below its line box', () => {
	const textarea = '.PromptComposer > textarea'
	const height = parseFloat(declaration(textarea, 'min-height')!)
	const line = parseFloat(declaration(textarea, 'line-height')!)
	const padding = parseFloat(declaration(textarea, 'padding')!)
	// The left rail is the only border: top and bottom have equal 10px padding.
	expect(line + 2 * padding).toBe(height)
})

test('tab strip measures its width and renders only visible, keyboard-focusable shortcuts', () => {
	const source = readFileSync(resolve(webDir, 'components/SessionTabs.tsx'), 'utf8')
	expect(source).toContain('new ResizeObserver(')
	expect(source).toContain('sessionActivity.capacity(')
	expect(source).toContain('<For each={shown()} keyed={(session) => session.id}>')
	expect(declaration('.SessionTabs > .SessionTabs-rail', 'min-width')).toBe('0')
	expect(declaration('.SessionTabs-rail > button', 'width')).toBe('56px')
})

test('phone editing grows the draft while retaining context and avoiding the bottom inset', () => {
	const media = '@media (max-width: 48em)'
	const focused = '#app:has(> .PromptComposer > textarea:focus)'
	const composer = `${focused} > .PromptComposer`
	expect(declarationInside(media, `${focused} > .Transcript`, 'min-height')).toBe('min(64px, 15%)')
	expect(declarationInside(media, composer, 'flex')).toBe('0 1 auto')
	expect(declarationInside(media, composer, 'flex-direction')).toBe('column')
	expect(declarationInside(media, composer, 'padding-bottom')).toBe('8px')
	expect(declarationInside(media, `${composer} > textarea`, 'max-height')).toBe('none')
	// CSS keeps the desktop cap; JS must measure the whole draft, not eight lines.
	const source = readFileSync(resolve(webDir, 'components/PromptComposer.tsx'), 'utf8')
	expect(source).toContain('`${input.scrollHeight}px`')
	expect(declaration('.PromptComposer > textarea', 'max-height')).toBe('168px')
})

test('tab header keeps the current name and complete searchable session menu at any size', () => {
	const source = readFileSync(resolve(webDir, 'components/SessionTabs.tsx'), 'utf8')
	expect(source).toContain('class="SessionTabs-title" title={props.status}')
	expect(source).toContain('sessionActivity.ordered(')
	expect(source).toContain('sessionActivity.matches(session, query(), number())')
	expect(source).toContain('aria-label="Find session"')
	expect(declaration('.SessionTabs-list > div[hidden]', 'display')).toBe('none')
})

test('numbered tabs precede the smaller session name without narrowing the strip', () => {
	const source = readFileSync(resolve(webDir, 'components/SessionTabs.tsx'), 'utf8')
	expect(source.indexOf('<nav class="SessionTabs-rail"')).toBeLessThan(source.indexOf('<span class="SessionTabs-title"'))
	expect(declaration('.SessionTabs > .SessionTabs-rail', 'grid-row')).toBe('1')
	expect(declaration('.SessionTabs > .SessionTabs-title', 'grid-row')).toBe('2')
	expect(declaration('.SessionTabs > .SessionTabs-title', 'font-size')).toBe('13px')
})

test('session menu reveals the current tab and keeps actions outside the scrolling list', () => {
	const source = readFileSync(resolve(webDir, 'components/SessionTabs.tsx'), 'utf8')
	expect(source).toContain('dialog.showModal()')
	expect(source).toContain("'[aria-current=\"page\"]'")
	expect(source).toContain("current?.scrollIntoView({ block: 'center' })")
	expect(source).toContain('<Show when={appActions.isInstalled()}>')
	expect(declaration('.SessionTabs-list', 'overflow-y')).toBe('auto')
	expect(declaration('.SessionTabs-actions', 'flex')).toBe('none')
	expect(declaration('.SessionTabs-list > div.selected', 'background')).toBe('var(--user-bg, var(--page))')
})


test('session menu shows each session cwd without letting long paths distort its row', () => {
	const source = readFileSync(resolve(webDir, 'components/SessionTabs.tsx'), 'utf8')
	expect(source).toContain('<span class="SessionTabs-cwd" title={session.cwd}>{session.cwd}</span>')
	expect(declaration('.SessionTabs-open > .SessionTabs-cwd', 'overflow')).toBe('hidden')
	expect(declaration('.SessionTabs-open > .SessionTabs-cwd', 'text-overflow')).toBe('ellipsis')
	expect(declaration('.SessionTabs-open > .SessionTabs-cwd', 'white-space')).toBe('nowrap')
})
