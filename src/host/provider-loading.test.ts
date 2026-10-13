import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

function isolated(body: string): void {
	let home = mkdtempSync(`${tmpdir()}/hal-provider-loading-`)
	try {
		let env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.endsWith('_API_KEY')))
		let script = `
			const assert = require('node:assert/strict');
			globalThis.fetch = async () => { throw new Error('Network forbidden'); };
			require('./src/main.ts');
			const { providers } = require('./src/host/providers.ts');
			const { provider } = require('./src/host/provider.ts');
			const { models } = require('./src/host/models.ts');
			const { synthetic } = require('./src/host/synthetic.ts');
			const loaded = name => Object.hasOwn(require.cache, require.resolve('./src/host/' + name + '.ts'));
			const implementations = ['anthropic', 'openai', 'openai-compat', 'openai-ws', 'intro', 'tool-model', 'scroll-test', 'queue-test', 'plugin-sync-session'];
			require('./src/host/lifecycle.ts').lifecycle.initHost();
			for (const name of implementations) assert.equal(loaded(name), false, name + ' loaded on startup');
			${body}
			process.exit(0);
		`
		let result = Bun.spawnSync([process.execPath, '-e', script], { cwd: `${import.meta.dir}/../..`, env: { ...env, HAL_HOME: home, TMPDIR: home }, stdout: 'pipe', stderr: 'pipe' })
		expect(result.stderr.toString()).toBe('')
		expect(result.exitCode).toBe(0)
	} finally { rmSync(home, { recursive: true, force: true }) }
}

test('startup, command discovery and catalog metadata do not load model implementations', () => {
	isolated(`
		require('./src/host/commands.ts').commands.all();
		assert(models.known().includes('openai/gpt-6-astra'));
		assert(models.valid('anthropic/unknown-model'));
		assert(!models.valid('../openai/model'));
		assert(!models.valid('constructor/model'));
		assert.equal(synthetic.find('hal/../../intro'), undefined);
		assert.equal(synthetic.find('hal/constructor'), undefined);
		models.nameEvent(models.known());
		for (const name of implementations) assert.equal(loaded(name), false, name + ' loaded for metadata');
		let before = provider.state.providers.openai;
		providers.init();
		assert.equal(provider.state.providers.openai, before);
		provider.register('openai', { request() {}, parse() {} });
		assert.notEqual(provider.state.providers.openai, before);
	`)
})

test('one provider loads only its own adapter, reused on subsequent calls', () => {
	for (let [name, implementation] of [['anthropic', 'anthropic'], ['openai', 'openai'], ['ollama', 'openai-compat']]) isolated(`
		const p = provider.state.providers[${JSON.stringify(name)}];
		p.parse((async function* () {})());
		assert(loaded(${JSON.stringify(implementation)}));
		for (const name of implementations.filter(n => ![${JSON.stringify(implementation)}, 'openai-ws'].includes(n))) assert.equal(loaded(name), false, name + ' loaded with another provider');
		const path = './src/host/' + ${JSON.stringify(implementation)} + '.ts';
		const id = require.resolve(path), first = require.cache[id];
		p.parse((async function* () {})());
		assert.equal(require.cache[id], first);
	`)
})

test('invoking one synthetic model leaves the other scripts unloaded', () => {
	isolated(`
		assert(synthetic.find('hal/scroll-test')([]).stream);
		assert(loaded('scroll-test'));
		for (const name of implementations.filter(n => n !== 'scroll-test')) assert.equal(loaded(name), false, name);
	`)
})
