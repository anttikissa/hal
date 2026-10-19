// The browser client page: src/web/ bundled into index.html with the
// JSX compiler (loaded only on first build), the theme CSS written into
// it, and a rebuild when its source changes. web.ts serves it.

import type { BunPlugin } from 'bun'
import { watch, type FSWatcher } from 'fs'
import { ason } from '../common/ason.ts'
import { colors, DERIVED, type Style } from '../common/colors.ts'
import { sendKeys } from '../common/send-keys.ts'
import { oklch } from '../common/oklch.ts'
import { settings } from '../common/settings.ts'
import { diag } from './diag.ts'
import { push } from './push.ts'
import { web } from './web.ts'

// The JSX compiler, loaded on first use: nothing else on the host
// path needs it. Missing or broken, it fails the page, not the host.
const compiler = (): Promise<{ transform(source: string, opts: object): { code: string } }> =>
	import('@solidjs/compiler')

// A Bun plugin compiling .tsx into Solid's DOM calls.
async function plugin(): Promise<BunPlugin> {
	let { transform } = await webPage.compiler()
	return {
		name: 'solid',
		setup(build) {
			build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
				contents: transform(await Bun.file(args.path).text(), {
					filename: args.path,
					moduleName: '@solidjs/web',
					generate: 'dom',
				}).code,
				loader: 'ts',
			}))
		},
	}
}

// The browser client (src/web/): index.html with main.tsx bundled into
// it, built on first request and kept until its source changes. The
// format is iife: esm output breaks an inline classic script. `version`,
// a hash of the page, is also in it, so a page can tell whether it was
// built from the host's code.
async function build(): Promise<{ html: string; version: string }> {
	let dir = `${import.meta.dir}/../web`
	let plugins = [await webPage.plugin()]
	let out = await Bun.build({
		entrypoints: [`${dir}/main.tsx`],
		target: 'browser',
		format: 'iife',
		minify: true,
		plugins,
	})
	if (!out.success) throw new AggregateError(out.logs, 'web: bundling src/web/main.tsx failed')
	let js = (await out.outputs[0]!.text()).replaceAll('</script', '<\\/script')
	let html = (await Bun.file(`${dir}/index.html`).text()).replace('/*APP*/', () => js)
	let version = Bun.hash(html).toString(36)
	return { html: html.replace('/*VERSION*/', version), version }
}

// The version of the page this host serves; undefined if it can't build.
async function version(): Promise<string | undefined> {
	webPage.state.page ??= webPage.build()
	return webPage.state.page.then(
		(p) => p.version,
		() => undefined,
	)
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

// The theme as CSS, computed now so overrides show on the next load,
// as oklch() (wide-gamut screens show the full color; the terminal
// gets it fitted to sRGB):
// one class per style (toolBash is .tool-bash) with fg as color, bg as
// background and any other color as a custom property (--link-bg),
// plus --quiet: the fg's quieter, still readable form (colors.quiet), for
// secondary text, which never fades by opacity (tasks/README.md). The
// page's is measured on its lightest surface, the button.
// --fg and --sel-back repeat the fg for selection; --output is the
// machine-output color (colors.toolOutput).
function css(): string {
	let rules: string[] = []
	for (let [key, value] of Object.entries(colors)) {
		if ((DERIVED as readonly string[]).includes(key)) continue
		if (key === 'mix') {
			rules.push(
				`:root { ${Object.entries(colors.mix)
					.map(([k, v]) => `--mix-${kebab(k)}: ${v}%`)
					.join('; ')} }`,
			)
			continue
		}
		// Shared values (fgL, screen) are numbers or one color, not styles.
		if (typeof value !== 'function') continue
		let style = (value as () => Style)()
		let decls = Object.entries(style).map(([part, c]) => {
			let prop = part === 'fg' ? 'color' : part === 'bg' ? 'background-color' : `--${kebab(part)}`
			return `${prop}: ${oklch.toCss(c)}`
		})
		if (style.bg) decls.push(`--card-bg: ${oklch.toCss(style.bg)}`)
		let fg = style.fg ?? style.text
		if (fg) decls.push(`--quiet: ${oklch.toCss(colors.quiet(fg, style.bg ?? style.button ?? colors.screen))}`)
		if (fg) decls.push(`--title-fg: ${oklch.toCss(style.title ?? colors.title(fg))}`)
		// Selection is reverse video in the style's own color (task gn).
		if (fg) decls.push(`--fg: ${oklch.toCss(fg)}`, `--sel-back: ${oklch.toCss(fg)}`)
		if (fg && !style.output) decls.push(`--output: ${oklch.toCss(colors.toolOutput(fg))}`)
		if (key === 'input' && style.placeholder) decls.push(`--faint: ${oklch.toCss(style.placeholder)}`)
		rules.push(`.${kebab(key)} { ${decls.join('; ')} }`)
	}
	let tab = colors.tab(),
		hal = colors.assistant()
	for (let [kind, fg] of Object.entries({
		asking: tab.doneFg!,
		approval: tab.warningFg!,
		blocked: tab.warningFg!,
		retrying: tab.warningFg!,
		working: hal.cursor!,
		jobs: tab.jobsFg!,
		failed: tab.errorFg!,
		paused: tab.pausedFg!,
		done: tab.doneFg!,
	})) {
		rules.push(
			`.Tabs .marker.${kind} { --mark-lit: ${oklch.toCss(fg)}; --mark-dark: ${oklch.toCss(kind === 'working' ? hal.cursorIdle! : colors.blinkDim(fg))} }`,
		)
	}
	// Percentages used, one class per whole percent (colors.heat).
	for (let used = 0; used <= 100; used++)
		rules.push(`.heat-${used} { --heat: ${oklch.toCss(colors.heat(used))}; color: var(--heat) }`)
	return rules.join('\n')
}

async function page(): Promise<Response> {
	webPage.state.page ??= webPage.build()
	let html: string
	try {
		html = (await webPage.state.page).html
	} catch (e: any) {
		webPage.state.page = null
		diag.log(`${e?.message ?? e}: ${e?.errors?.join('\n') ?? ''}`)
		return new Response('the web client failed to build; see diag.log\n', { status: 500 })
	}
	html = html
		.replace('/*COLORS*/', () => webPage.css())
		.replace('/*SETTINGS*/', () => settings.forPage())
		.replace('/*SEND_KEYS*/', () => sendKeys.forPage())
	// Public signing key only, encoded into JSON safely (never the private key).
	try {
		let key = (await push.keys()).publicKey
		html = html.replace('/*PUSH_KEY*/', () => JSON.stringify(key))
	} catch (e: any) {
		diag.log(`push: ${e?.message ?? e}`)
		html = html.replace('/*PUSH_KEY*/', 'null')
	}
	return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

// Once a page was built, a change to src/web or src/common (task zz)
// rebuilds it, and notifies opted-in pages without dropping their link.
// Legacy pages reload on code 4000. Remote terminals stay connected;
// a failed build (a half-saved edit) notifies nothing.
async function refresh(): Promise<void> {
	webPage.state.page = webPage.build()
	let v = await webPage.version()
	if (v)
		for (let ws of web.state.sockets)
			if (ws.data.page && ws.data.page !== v) {
				if (ws.data.manualUpdates) ws.send(ason.stringify({ type: 'web-update' }, 'short'))
				else ws.close(4000, 'reload')
			}
}

function watchSource(): FSWatcher | null {
	let timer: Timer | undefined
	try {
		return watch(`${import.meta.dir}/..`, { recursive: true, persistent: false }, (_e, name) => {
			if (!webPage.state.page || !name || !/^(web|common)\//.test(String(name)) || String(name).includes('.test.'))
				return
			clearTimeout(timer)
			timer = setTimeout(() => void webPage.refresh(), 300)
		})
	} catch {
		return null
	}
}

export const webPage = {
	state: {
		page: null as Promise<{ html: string; version: string }> | null,
		watcher: null as FSWatcher | null,
	},
	css,
	compiler,
	plugin,
	build,
	refresh,
	version,
	page,
	watchSource,
}
