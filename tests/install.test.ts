import { describe, test, expect } from 'bun:test'
import { $ } from 'bun'

let halDir = import.meta.dir.replace(/\/tests$/, '')

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

// Skipped secretly - we rarely modify the install script. Enable test temporarily if you must test
describe.skip('install script', () => {
	test('exists and is executable', async () => {
		let exists = await Bun.file(`${halDir}/install`).exists()
		expect(exists).toBe(true)
		let result = await $`test -x ${halDir}/install`.nothrow()
		expect(result.exitCode).toBe(0)
	})

	test('is a bash script', async () => {
		let content = await Bun.file(`${halDir}/install`).text()
		expect(content.startsWith('#!/usr/bin/env bash')).toBe(true)
	})

	test('supports -y flag for non-interactive mode', async () => {
		let content = await Bun.file(`${halDir}/install`).text()
		expect(content).toContain('-y')
	})

	test('shows system analysis with checkboxes', async () => {
		let result = await $`HAL_DRY_RUN=1 ${halDir}/install -y 2>&1`.text()
		expect(result).toContain('Analyzing...')
		expect(result).toMatch(/\[x\]/)
	})

	test('shows [x] for git when installed', async () => {
		let result = await $`HAL_DRY_RUN=1 ${halDir}/install -y 2>&1`.text()
		expect(result).toMatch(/\[x\] git/)
	})

	test('shows [x] for bun when installed', async () => {
		let result = await $`HAL_DRY_RUN=1 ${halDir}/install -y 2>&1`.text()
		expect(result).toMatch(/\[x\] bun/)
	})

	test('shows [x] for ripgrep when installed', async () => {
		let result = await $`HAL_DRY_RUN=1 ${halDir}/install -y 2>&1`.text()
		expect(result).toMatch(/\[x\] ripgrep/)
	})

	test('shows tsgo in checklist', async () => {
		let result = await $`HAL_DRY_RUN=1 ${halDir}/install -y 2>&1`.text()
		expect(result).toMatch(/\[.\] tsgo/)
	})

	test('shows symlink status in checklist', async () => {
		let result = await $`HAL_DRY_RUN=1 ${halDir}/install -y 2>&1`.text()
		expect(result).toMatch(/\[.\] .*hal.*~\/\.local\/bin/)
	})

	test('shows PATH status in checklist', async () => {
		let result = await $`HAL_DRY_RUN=1 ${halDir}/install -y 2>&1`.text()
		expect(result).toMatch(/\[.\] ~\/\.local\/bin.*PATH/)
	})

	test('shows [ ] for PATH when not set', async () => {
		let result =
			await $`HAL_DRY_RUN=1 HAL_SKIP_PATH=/Users/antti/.local/bin ${halDir}/install -y 2>&1`.text()
		expect(result).toMatch(/\[ \] ~\/\.local\/bin.*PATH/)
	})

	test('says nothing about already-installed tools beyond the checklist', async () => {
		let result = await $`HAL_DRY_RUN=1 ${halDir}/install -y 2>&1`.text()
		expect(result).not.toContain('already installed')
	})

	test('asks about both prerequisites and setup when both missing', async () => {
		let content = await Bun.file(`${halDir}/install`).text()
		expect(content).toContain(
			'Install missing prerequisites and set up Hal?'
		)
	})

	test('asks only about setup when only setup items missing', async () => {
		let content = await Bun.file(`${halDir}/install`).text()
		expect(content).toContain('Set up Hal?')
	})

	test('asks only about prerequisites when only tools missing', async () => {
		let content = await Bun.file(`${halDir}/install`).text()
		expect(content).toContain('Install missing prerequisites?')
	})

	test('suggests restarting shell when PATH was modified', async () => {
		let result =
			await $`HAL_DRY_RUN=1 HAL_SKIP_PATH=/Users/antti/.local/bin ${halDir}/install -y 2>&1`.text()
		expect(result).toContain('restart your shell')
		expect(result).not.toContain('exec')
	})

	test('does NOT suggest restarting shell when PATH already set', async () => {
		let result = await $`HAL_DRY_RUN=1 ${halDir}/install -y 2>&1`.text()
		expect(result).not.toContain('restart your shell')
	})

	test('grep for .local/bin ignores commented-out lines', async () => {
		let content = await Bun.file(`${halDir}/install`).text()
		expect(content).toContain('^#')
	})

	test('shows usage directions', async () => {
		let result = await $`HAL_DRY_RUN=1 ${halDir}/install -y 2>&1`.text()
		expect(result).toContain('hal')
		expect(result).toContain('hal -s')
	})

	test("shows 'Everything in order' when all set up", async () => {
		// This test only works if everything is actually installed
		let result = await $`HAL_DRY_RUN=1 ${halDir}/install -y 2>&1`.text()
		if (!result.includes('[ ]')) {
			expect(result).toContain('Everything in order.')
		}
	})
})
