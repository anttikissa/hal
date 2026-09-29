import { afterEach, expect, test } from 'bun:test'
import { clipboard } from './clipboard.ts'
import { terminal } from './terminal.ts'

// Never the real clipboard: the environment and the commands are faked.
const saved = { ...clipboard }
const savedIO = terminal.state.io
let ran: { cmd: string[]; input?: string }[] = []
let written: string[] = []

// `works`: the command names that run; each prints `out`.
function fake(env: { platform: string; ssh?: boolean; wayland?: boolean }, works: string[], out = 'clip') {
	ran = []
	written = []
	clipboard.env = () => ({ ssh: false, wayland: false, ...env })
	clipboard.run = async (cmd, input) => {
		ran.push(input === undefined ? { cmd } : { cmd, input })
		return works.includes(cmd[0]!) ? out : null
	}
	terminal.state.io = { write: (s: string) => written.push(s) } as any
}

afterEach(() => {
	Object.assign(clipboard, saved)
	terminal.state.io = savedIO
})

test('on macOS text goes to pbcopy and comes from pbpaste', async () => {
	fake({ platform: 'darwin' }, ['pbcopy', 'pbpaste'], 'from mac')
	expect(await clipboard.write('héllo')).toBeUndefined()
	expect(await clipboard.read()).toEqual({ text: 'from mac' })
	expect(ran).toEqual([{ cmd: ['pbcopy'], input: 'héllo' }, { cmd: ['pbpaste'] }])
})

test('on Linux a missing first tool falls back to the other', async () => {
	fake({ platform: 'linux', wayland: true }, ['xclip'])
	expect(await clipboard.write('x')).toBeUndefined()
	expect(ran.map((r) => r.cmd[0])).toEqual(['wl-copy', 'xclip'])
	expect(await clipboard.read()).toEqual({ text: 'clip' })
})

test('over SSH a copy is OSC 52 to the terminal and spawns nothing', async () => {
	fake({ platform: 'linux', ssh: true }, ['xclip'])
	expect(await clipboard.write('hi ✓')).toBeUndefined()
	expect(ran).toEqual([])
	let m = /^\x1b\]52;c;([A-Za-z0-9+/=]*)\x07$/.exec(written.join(''))
	expect(Buffer.from(m![1]!, 'base64').toString()).toBe('hi ✓')
})

test('with no tool, copy and paste give a notice instead of throwing', async () => {
	fake({ platform: 'linux' }, [])
	expect(await clipboard.write('x')).toMatch(/clipboard/)
	expect(await clipboard.read()).toEqual({ notice: expect.stringMatching(/clipboard/) })
})

test('a command that runs gives its output and gets its input; a missing one is null, not an exception', async () => {
	expect(await clipboard.run(['/nonexistent/hal-no-such-tool'], 'x')).toBeNull()
	expect(await clipboard.run(['/nonexistent/hal-no-such-tool'])).toBeNull()
	expect(await clipboard.run(['cat'], 'round trip')).toBe('round trip')
	expect(await clipboard.run(['false'])).toBeNull()
})

test('on Linux the image comes as PNG from the session tool first, else the other', async () => {
	let asked: string[] = []
	let png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
	clipboard.exec = async (cmd) => {
		asked.push(cmd[0]!)
		return cmd.includes('image/png') && cmd[0] === 'xclip' ? png : null
	}
	clipboard.env = () => ({ platform: 'linux', ssh: false, wayland: true })
	expect(await clipboard.image()).toEqual(png)
	expect(asked).toEqual(['wl-paste', 'xclip'])
	clipboard.exec = async () => new Uint8Array()
	expect(await clipboard.image()).toBeNull()
	clipboard.env = () => ({ platform: 'win32', ssh: false, wayland: false })
	expect(await clipboard.image()).toBeNull()
})
