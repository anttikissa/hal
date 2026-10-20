// Finds the providers: each file in providers/ is one, loaded on first
// use, plus the OpenAI-compatible endpoints of compat-catalog.ts.
// available() says whether Anthropic or OpenAI has credentials.
import { readdirSync, existsSync } from 'fs'
import { auth, type Kind } from './auth.ts'
import { paths } from './paths.ts'
import { provider, type Provider } from './provider.ts'
import { compatCatalog } from './compat-catalog.ts'

function init(): void {
	for (let file of readdirSync(providers.dir()).sort()) {
		if (!/^[a-z][a-z0-9-]*\.ts$/.test(file)) continue
		let name = file.slice(0, -3),
			path = `${providers.dir()}/${file}`
		if (Object.hasOwn(provider.state.providers, name)) continue
		Object.defineProperty(provider.state.providers, name, {
			enumerable: true,
			configurable: true,
			get: () => (provider.state.providers[name] = (require(path) as { provider: Provider }).provider),
			set: (value: Provider) =>
				Object.defineProperty(provider.state.providers, name, {
					value,
					writable: true,
					enumerable: true,
					configurable: true,
				}),
		})
	}
	for (let name of Object.keys(compatCatalog.endpoints()))
		if (!Object.hasOwn(provider.state.providers, name)) provider.register(name, compatCatalog.create(name))
}

function available(kind: Kind): boolean {
	return !!auth.envKey(kind) || (existsSync(paths.authFile()) && auth.accounts(auth.store(), kind).length > 0)
}

export const providers = { init, available, dir: () => `${import.meta.dir}/providers` }
