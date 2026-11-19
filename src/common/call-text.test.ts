import { expect, test } from 'bun:test'
import { callText } from './call-text.ts'

const isTool = (name: string) => ['read', 'bash', 'edit', 'eval'].includes(name)
const split = (text: string) => callText.split(text, isTool)

test('EDIT source code stays literal while surrounding commands still split', () => {
	let edit = `EDIT /* Preserve effects */
sound.ts@abcde replace 88-88
!!NEW
      this.factory[n] = this.factory[n]! | 15;
!!END
sound.ts@abcde replace 116-117
!!NEW
    if (register < 96 && ![8, 9, 10, 21].includes(register & 31)) this.factory[register >> 5] = 0;
    if (register >= FLT && register < FLT + 16) this.factoryFilter = false;
!!END`
	expect(split(edit)).toEqual([edit])
	expect(split(`READ sound.ts\n${edit}\nBASH "check"`)).toEqual(['READ sound.ts', edit, 'BASH "check"'])
})

test('EDIT old and new blocks preserve tool names, quotes, comments and escaped markers', () => {
	let edit = `EDIT a.txt replace
!!OLD
READ missing.txt
'unmatched
/* unclosed
!!!END
!!NEW
BASH "do not execute"
!!!NEW
!!END`
	for (let newline of ['\n', '\r\n']) {
		let text = edit.replaceAll('\n', newline)
		expect(split(`${text}${newline}READ a.txt`)).toEqual([text, 'READ a.txt'])
	}
})

test('unclosed EDIT blocks reach validation intact rather than becoming commands', () => {
	let edit = 'EDIT a.txt create\n!!NEW\nREAD missing.txt\nif (ready) run();'
	expect(split(edit)).toEqual([edit])
})

test('EVAL code runs to the end, even past lines starting with tool names', () => {
	let code = 'EVAL /* Chain */\nlet read = 1\nREAD "x"\nreturn read'
	expect(split(code)).toEqual([code])
	expect(split(`BASH "ls"\n${code}`)).toEqual(['BASH "ls"', code])
})

test('a line starts a new call only at a tool name, so bare paths stay in their EDIT', () => {
	let edit = 'EDIT /* Add deploy */\ndeploy create\n!!NEW\nf() {\n}\n!!END'
	expect(split(`${edit}\nBASH "./deploy"`)).toEqual([edit, 'BASH "./deploy"'])
})

test('a !!START block keeps quotes, backslashes, blank lines and escaped markers byte-exact', () => {
	let content = `grep -E '\\d+ "x"' a\\\\b\n\n  READ "no"\n!!END\n!!START\n`
	let escaped = content.replace('!!END', '!!!END').replace('!!START', '!!!START')
	for (let nl of ['\n', '\r\n']) {
		let raw = ` /* Find */ { timeout: 5 }${nl}!!START${nl}${escaped.replaceAll('\n', nl)}${nl}!!END${nl}`
		let crlf = nl === '\r\n' ? content.replaceAll('\n', '\r\n') : content
		expect(callText.values(raw)).toEqual({ values: [{ timeout: 5 }], purpose: 'Find', block: crlf })
	}
	expect(callText.values('\n!!START\n!!END').block).toBe('')
})

test('calls never split inside a block; EVAL with a block ends at its !!END', () => {
	let bash = 'BASH\n!!START\nREAD "x"\nEVAL 1\n!!END'
	expect(split(`${bash}\nREAD a.ts`)).toEqual([bash, 'READ a.ts'])
	let evalBlock = 'EVAL /* Chain */\n!!START\nread = 1\n!!END'
	expect(split(`${evalBlock}\nREAD a.ts`)).toEqual([evalBlock, 'READ a.ts'])
})

test('malformed blocks fail with distinct codes', () => {
	let code = (raw: string) => {
		try {
			callText.values(raw)
		} catch (e: any) {
			return e.code
		}
	}
	expect(code('\n!!START\nls')).toBe('block-unclosed')
	expect(code('\n!!START\na\n!!START\nb\n!!END')).toBe('block-nested')
	expect(code('\n!!START\na\n!!END\n!!START\nb\n!!END')).toBe('block-two')
	expect(code('\n!!NEW\nls\n!!END')).toBe('block-new')
	expect(code('\n!!OLD\nls\n!!END')).toBe('block-old')
	expect(code('\n!!END')).toBe('block-stray-end')
})
