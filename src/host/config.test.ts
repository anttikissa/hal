// config.ason: the live file behind settings.<name>().
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { settings } from '../common/settings.ts'
import { config } from './config.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

const savedHome = process.env.HAL_HOME
const origOnError = liveFiles.onError
let home = ''
let changes = 0

beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-config-`)
	process.env.HAL_HOME = home
	liveFiles.onError = () => {}
	changes = 0
})

afterEach(() => {
	config.reset()
	liveFiles.onError = origOnError
	if (savedHome === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = savedHome
	rmSync(home, { recursive: true, force: true })
})

const defaults = () => settings.check({}).values

// Editors replace files atomically.
function edit(text: string): void {
	writeFileSync(`${paths.configFile()}.ext`, text)
	renameSync(`${paths.configFile()}.ext`, paths.configFile())
}

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(50)
}

function start(): void {
	config.init(() => changes++)
}

test('a missing file means all defaults, no warnings, and is not created', async () => {
	start()
	expect(settings.model()).toBe(defaults().model as string)
	expect(settings.webPort()).toBe(defaults().webPort as number)
	expect(config.warnings()).toEqual([])
	await Bun.sleep(20)
	expect(await Bun.file(paths.configFile()).exists()).toBe(false)
})

test('values in config.ason are what settings return', () => {
	writeFileSync(paths.configFile(), "{ model: 'test/from-file', webPort: 4321 }\n")
	start()
	expect(settings.model()).toBe('test/from-file')
	expect(settings.webPort()).toBe(4321)
	expect(settings.security()).toBe(defaults().security as 'best-effort')
})

test('edits apply at once and are announced', async () => {
	writeFileSync(paths.configFile(), "{ model: 'test/one' }\n")
	start()
	await Bun.sleep(50)
	edit("{ model: 'test/two' }\n")
	await until(() => settings.model() === 'test/two')
	expect(settings.model()).toBe('test/two')
	await until(() => changes > 0)
	expect(changes).toBeGreaterThan(0)
})

test('bad values and unknown keys warn, naming the file, and fall back', () => {
	writeFileSync(paths.configFile(), "{ webPort: 'nope', colour: 'red', model: 'test/ok' }\n")
	start()
	let w = config.warnings()
	expect(w.length).toBe(2)
	for (let line of w) expect(line).toContain('config.ason')
	expect(w.some((l) => l.includes('webPort'))).toBe(true)
	expect(w.some((l) => l.includes('colour'))).toBe(true)
	expect(settings.webPort()).toBe(defaults().webPort as number)
	expect(settings.model()).toBe('test/ok')
})

test('a malformed file never crashes: defaults, a warning, and fixing it applies', async () => {
	writeFileSync(paths.configFile(), "{ model: 'sk-secret' oops")
	start()
	expect(settings.model()).toBe(defaults().model as string)
	let w = config.warnings()
	expect(w.length).toBe(1)
	expect(w[0]).toContain('config.ason')
	expect(w[0]).not.toContain('sk-secret')
	edit("{ model: 'test/fixed' }\n")
	await until(() => settings.model() === 'test/fixed')
	expect(settings.model()).toBe('test/fixed')
	expect(config.warnings()).toEqual([])
})

test('hand-written comments on keys and array items survive a save', () => {
	writeFileSync(
		paths.configFile(),
		`{
	// the model I like
	model: 'test/a',
	extra: [
		// first
		1,
		/* second */
		2,
	],
}
`,
	)
	start()
	config.state.data!.model = 'test/b'
	liveFiles.save(config.state.data!)
	let text = readFileSync(paths.configFile(), 'utf8')
	expect(text).toContain("// the model I like\n\tmodel: 'test/b'")
	expect(text).toContain('// first\n\t\t1,')
	expect(text).toContain('/* second */\n\t\t2')
})
