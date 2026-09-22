import { describe, test, expect } from 'bun:test'
import { $ } from 'bun'

let halDir = import.meta.dir.replace(/\/tests$/, '')
// HAL_SKIP_PATH makes the installer pretend this entry is missing from PATH, so
// it has to match the real entry the installer looks for on this machine.
let localBin = `${process.env.HOME}/.local/bin`

test('installer creates local config from tracked template', async () => {
	let install = await Bun.file(`${halDir}/install`).text()
	let ignore = await Bun.file(`${halDir}/.gitignore`).text()
	let templateExists = await Bun.file(`${halDir}/config-template.ason`).exists()

	expect(templateExists).toBe(true)
	expect(ignore).toContain('/config.ason')
	expect(install).toContain('local config.ason')
	expect(install).toContain('config-template.ason')
	expect(install).toContain('cp "$hal_dir/config-template.ason" "$hal_dir/config.ason"')
})

test('run delegates incomplete local setup to install, with -l preserved for the installer', async () => {
	let run = await Bun.file(`${halDir}/run`).text()

	expect(run).toContain('-l)')
	expect(run).toContain('"$hal_dir/install" -l')
	expect(run).toContain('"$hal_dir/install"')
	expect(run).not.toContain('"$HOME/.local/bin/hal"')
	expect(run).not.toContain('grep -qx "$HOME/.local/bin"')
})

test('installer local mode leaves the global command and PATH alone', async () => {
	let install = await Bun.file(`${halDir}/install`).text()

	expect(install).toContain('-l) local_only=1')
	expect(install).toContain('Local setup (--local): files outside this directory will not be modified.')
	expect(install).toContain('if [ -z "$local_only" ] && [ -n "$need_symlink" ]; then')
	expect(install).toContain('if [ -z "$local_only" ] && [ -n "$need_path" ]; then')
})
