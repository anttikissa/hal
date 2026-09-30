// Design demo pages (task 86): GET /demo/<name> answers
// src/web/demo/<name>.html with the theme CSS in place of /*COLORS*/.
// web.ts gates them behind the login like every page. The name is
// checked whole before it becomes a path.

function owns(path: string): boolean {
	return /^\/demo\/[a-z0-9-]+$/.test(path)
}

async function serve(pathname: string, css: string): Promise<Response> {
	let file = Bun.file(`${import.meta.dir}/../web/demo/${pathname.slice('/demo/'.length)}.html`)
	if (!(await file.exists())) return new Response('not found\n', { status: 404 })
	let html = (await file.text()).replace('/*COLORS*/', () => css)
	return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" } })
}

export const demoPage = { owns, serve }
