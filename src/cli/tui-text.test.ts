import { describe, expect, it } from 'bun:test'
import { linkifyLine, normalizeDetectedUrl, underlineOsc8Link, urlAtCol } from './tui-links.ts'
import { truncateAnsi, wrapAnsi } from './tui-text.ts'

const osc8 = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`

describe('linkifyLine', () => {
	it('wraps a plain https URL with OSC 8', () => {
		const input = 'visit https://example.com for info'
		const result = linkifyLine(input)
		expect(result).toBe(`visit ${osc8('https://example.com', 'https://example.com')} for info`)
	})

	it('wraps http URL', () => {
		const result = linkifyLine('go to http://example.com now')
		expect(result).toBe(`go to ${osc8('http://example.com', 'http://example.com')} now`)
	})

	it('handles multiple URLs on one line', () => {
		const input = 'see https://a.com and https://b.com links'
		const result = linkifyLine(input)
		expect(result).toBe(
			`see ${osc8('https://a.com', 'https://a.com')} and ${osc8('https://b.com', 'https://b.com')} links`,
		)
	})

	it('trims trailing period', () => {
		const result = linkifyLine('Link: https://example.com.')
		expect(result).toBe(`Link: ${osc8('https://example.com', 'https://example.com')}.`)
	})

	it('trims trailing comma', () => {
		const result = linkifyLine('Link https://example.com, more')
		expect(result).toBe(`Link ${osc8('https://example.com', 'https://example.com')}, more`)
	})

	it('handles URL inside parentheses', () => {
		const result = linkifyLine('(https://example.com)')
		expect(result).toBe(`(${osc8('https://example.com', 'https://example.com')})`)
	})

	it('preserves balanced parens in URL (Wikipedia)', () => {
		const result = linkifyLine('see https://en.wikipedia.org/wiki/Rust_(video_game) for info')
		expect(result).toBe(
			`see ${osc8('https://en.wikipedia.org/wiki/Rust_(video_game)', 'https://en.wikipedia.org/wiki/Rust_(video_game)')} for info`,
		)
	})

	it('handles URL with query params', () => {
		const result = linkifyLine('url https://example.com?q=1&x=2 end')
		expect(result).toBe(
			`url ${osc8('https://example.com?q=1&x=2', 'https://example.com?q=1&x=2')} end`,
		)
	})

	it('handles URL with hash fragment', () => {
		const result = linkifyLine('see https://example.com/page#section here')
		expect(result).toBe(
			`see ${osc8('https://example.com/page#section', 'https://example.com/page#section')} here`,
		)
	})

	it('handles URL with path', () => {
		const result = linkifyLine('at https://example.com/foo/bar end')
		expect(result).toBe(
			`at ${osc8('https://example.com/foo/bar', 'https://example.com/foo/bar')} end`,
		)
	})

	it('handles mailto: links', () => {
		const result = linkifyLine('email mailto:user@example.com here')
		expect(result).toBe(
			`email ${osc8('mailto:user@example.com', 'mailto:user@example.com')} here`,
		)
	})

	it('handles ssh:// links', () => {
		const result = linkifyLine('connect ssh://host.com end')
		expect(result).toBe(`connect ${osc8('ssh://host.com', 'ssh://host.com')} end`)
	})

	it('handles ftp:// links', () => {
		const result = linkifyLine('get ftp://files.example.com/pub end')
		expect(result).toBe(
			`get ${osc8('ftp://files.example.com/pub', 'ftp://files.example.com/pub')} end`,
		)
	})

	it('preserves ANSI styling around URL', () => {
		const input = 'see \x1b[34mhttps://example.com\x1b[0m here'
		const result = linkifyLine(input)
		// OSC 8 wraps the URL visible chars; ANSI reset between URL and space is included in the link region
		expect(result).toBe(
			`see \x1b[34m\x1b]8;;https://example.com\x1b\\https://example.com\x1b[0m\x1b]8;;\x1b\\ here`,
		)
	})

	it('preserves ANSI styling before URL', () => {
		const input = '\x1b[1mbold\x1b[0m https://example.com end'
		const result = linkifyLine(input)
		expect(result).toBe(
			`\x1b[1mbold\x1b[0m ${osc8('https://example.com', 'https://example.com')} end`,
		)
	})

	it('returns same line if no URLs found', () => {
		const input = 'no links here'
		expect(linkifyLine(input)).toBe(input)
	})

	it('returns empty for empty input', () => {
		expect(linkifyLine('')).toBe('')
	})

	it('skips lines already containing OSC 8', () => {
		const input = `already ${osc8('https://example.com', 'linked')} text`
		expect(linkifyLine(input)).toBe(input)
	})

	it('handles URL at start of line', () => {
		const result = linkifyLine('https://example.com is great')
		expect(result).toBe(`${osc8('https://example.com', 'https://example.com')} is great`)
	})

	it('handles URL at end of line', () => {
		const result = linkifyLine('visit https://example.com')
		expect(result).toBe(`visit ${osc8('https://example.com', 'https://example.com')}`)
	})

	it('trims trailing exclamation', () => {
		const result = linkifyLine('wow https://example.com!')
		expect(result).toBe(`wow ${osc8('https://example.com', 'https://example.com')}!`)
	})

	it('trims trailing quote', () => {
		const result = linkifyLine('"https://example.com"')
		expect(result).toBe(`"${osc8('https://example.com', 'https://example.com')}"`)
	})

	it('handles URL in square brackets', () => {
		const result = linkifyLine('[https://example.com]')
		expect(result).toBe(`[${osc8('https://example.com', 'https://example.com')}]`)
	})

	it('preserves square brackets in URL', () => {
		const result = linkifyLine('https://example.com/[foo] end')
		expect(result).toBe(
			`${osc8('https://example.com/[foo]', 'https://example.com/[foo]')} end`,
		)
	})
})

describe('wrapAnsi with OSC 8', () => {
	it('preserves OSC 8 in short lines', () => {
		const input = `before ${osc8('https://x.com', 'link')} after`
		const result = wrapAnsi(input, 80)
		expect(result).toEqual([input])
	})

	it('closes and reopens OSC 8 across word wrap', () => {
		// "aaa link bbb" where link is OSC 8, wrapped at col 9
		const link = osc8('https://x.com', 'link')
		const input = `aaa ${link} bbb`
		const result = wrapAnsi(input, 9)
		// "aaa link " wraps at col 9, then "bbb" on next line
		expect(result.length).toBe(2)
		// First line should contain the link with close
		expect(result[0]).toContain('https://x.com')
		expect(result[0]).toContain('\x1b]8;;\x1b\\') // link closed
		// Second line should not contain a link
		expect(result[1]).not.toContain('\x1b]8;')
	})

	it('closes and reopens OSC 8 across hard wrap (mid-URL)', () => {
		// A URL that's longer than maxCols
		const link = osc8('https://example.com/very/long/path', 'https://example.com/very/long/path')
		const result = wrapAnsi(link, 20)
		expect(result.length).toBeGreaterThan(1)
		// Each continuation line should reopen the link
		for (let i = 1; i < result.length; i++) {
			expect(result[i]).toContain('\x1b]8;;https://example.com/very/long/path\x1b\\')
		}
	})
})

describe('truncateAnsi with OSC 8', () => {
	it('closes OSC 8 on truncation', () => {
		const input = osc8('https://x.com', 'this is a long link text')
		const result = truncateAnsi(input, 10)
		// Should have the close sequence before RESET
		expect(result).toContain('\x1b]8;;\x1b\\')
		expect(result).toContain('\x1b[0m')
	})

	it('does not add OSC 8 close if link already closed', () => {
		const input = `${osc8('https://x.com', 'link')} normal text here`
		const result = truncateAnsi(input, 40)
		// Count OSC 8 close sequences — should be exactly 1 (from the original)
		const closes = result.split('\x1b]8;;\x1b\\').length - 1
		expect(closes).toBe(1)
	})
})

describe('urlAtCol', () => {
	it('finds URL at column in plain text', () => {
		const line = 'visit https://example.com here'
		expect(urlAtCol(line, 6)).toBe('https://example.com')
		expect(urlAtCol(line, 15)).toBe('https://example.com')
		expect(urlAtCol(line, 24)).toBe('https://example.com')
	})

	it('returns null outside URL', () => {
		const line = 'visit https://example.com here'
		expect(urlAtCol(line, 0)).toBeNull()
		expect(urlAtCol(line, 5)).toBeNull()
		expect(urlAtCol(line, 25)).toBeNull()
	})

	it('finds URL via OSC 8 in linkified line', () => {
		const line = linkifyLine('visit https://example.com here')
		expect(urlAtCol(line, 6)).toBe('https://example.com')
		expect(urlAtCol(line, 15)).toBe('https://example.com')
	})

	it('returns null for empty line', () => {
		expect(urlAtCol('', 0)).toBeNull()
	})

	it('finds URL with ANSI around it', () => {
		const line = 'see \x1b[34mhttps://example.com\x1b[0m here'
		expect(urlAtCol(line, 4)).toBe('https://example.com')
		expect(urlAtCol(line, 0)).toBeNull()
	})
})

describe('underlineOsc8Link', () => {
	it('underlines matching OSC 8 link', () => {
		const line = linkifyLine('visit https://example.com here')
		const result = underlineOsc8Link(line, 'https://example.com')
		expect(result).toContain('\x1b[4m')
		expect(result).toContain('\x1b[24m')
		// The URL text should be between underline on/off
		const match = result.match(/\x1b\[4m(.*?)\x1b\[24m/)
		expect(match).not.toBeNull()
		expect(match![1]).toContain('https://example.com')
	})

	it('does not underline non-matching URL', () => {
		const line = linkifyLine('visit https://example.com here')
		const result = underlineOsc8Link(line, 'https://other.com')
		expect(result).not.toContain('\x1b[4m')
	})

	it('returns line unchanged when no OSC 8 links', () => {
		const line = 'plain text no links'
		expect(underlineOsc8Link(line, 'https://example.com')).toBe(line)
	})

	it('only underlines the matching link among multiple', () => {
		const line = linkifyLine('see https://a.com and https://b.com end')
		const result = underlineOsc8Link(line, 'https://b.com')
		const matches = result.match(/\x1b\[4m/g)
		expect(matches).toHaveLength(1)
		const section = result.match(/\x1b\[4m(.*?)\x1b\[24m/)
		expect(section![1]).toContain('https://b.com')
	})
})


describe('normalizeDetectedUrl', () => {
	it('strips markdown/code wrappers around URL', () => {
		expect(normalizeDetectedUrl('`http://localhost:9001`')).toBe('http://localhost:9001')
		expect(normalizeDetectedUrl('**http://localhost:9001**')).toBe('http://localhost:9001')
		expect(normalizeDetectedUrl('<http://localhost:9001>')).toBe('http://localhost:9001')
		expect(normalizeDetectedUrl('(http://localhost:9001)')).toBe('http://localhost:9001')
	})

	it('trims prose punctuation after wrapper cleanup', () => {
		expect(normalizeDetectedUrl('`http://localhost:9001`.')).toBe('http://localhost:9001')
		expect(normalizeDetectedUrl('"https://example.com,"')).toBe('https://example.com')
	})
})

