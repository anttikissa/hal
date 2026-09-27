async function bundleClient(entry = 'main.tsx'): Promise<string> {
	const { transform } = await import('@dom-expressions/compiler')
	const result = await Bun.build({
		entrypoints: [`${import.meta.dir}/../web-client/${entry}`],
		target: 'browser',
		minify: true,
		plugins: [{
			name: 'solid-oxc',
			setup(build) {
				build.onLoad({ filter: /\.tsx$/ }, async (args) => {
					const source = await Bun.file(args.path).text()
					return {
						contents: transform(source, { filename: args.path, moduleName: '@solidjs/web', generate: 'dom' }).code,
						loader: 'ts',
					}
				})
			},
		}],
	})
	if (!result.success || !result.outputs[0]) throw new Error(result.logs.map(String).join('\n'))
	return result.outputs[0].text()
}

