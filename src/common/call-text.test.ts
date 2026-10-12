import { expect, test } from 'bun:test'
import { callText } from './call-text.ts'

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
	expect(callText.split(edit)).toEqual([edit])
	expect(callText.split(`READ sound.ts\n${edit}\nBASH "check"`)).toEqual(['READ sound.ts', edit, 'BASH "check"'])
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
		expect(callText.split(`${text}${newline}READ a.txt`)).toEqual([text, 'READ a.txt'])
	}
})

test('unclosed EDIT blocks reach validation intact rather than becoming commands', () => {
	let edit = 'EDIT a.txt create\n!!NEW\nREAD missing.txt\nif (ready) run();'
	expect(callText.split(edit)).toEqual([edit])
})
