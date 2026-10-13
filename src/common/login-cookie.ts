// The web login cookie's name for an origin (task 8a). Browsers share
// cookies across ports, so each port gets its own: 'hal' on the default
// ports (HTTP 9001, HTTPS 443), else 'hal-<port>'.
export function loginCookie(origin: string): string {
	let url = URL.parse(origin)
	let https = url?.protocol === 'https:'
	let port = url?.port || (https ? '443' : '80')
	return port === (https ? '443' : '9001') ? 'hal' : `hal-${port}`
}
