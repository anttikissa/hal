import { expect, test } from 'bun:test'
import { client } from './app.ts'
import { webConnection } from './web-connection.ts'
import { webLinks } from './web-links.ts'

test('local session and tool links use the advertised bound port and local web token', () => {
	const origin = client.state.webOrigin
	const localToken = webLinks.localToken
	try {
		client.state.webOrigin = 'http://localhost:9002'
		webLinks.localToken = () => 'localToken12'
		expect(webLinks.url('05-wan')).toBe('http://localhost:9002/05-wan?auth=localToken12')
		expect(webLinks.url('05-wan', 'tool/a')).toBe('http://localhost:9002/05-wan?auth=localToken12#tool=tool%2Fa')
		expect(webLinks.imageUrl('05-wan', '000123-abc')).toBe('http://localhost:9002/images/05-wan/000123-abc?auth=localToken12')
		expect(webLinks.imageUrl('05-wan', '../secret')).toBe('')
		expect(webLinks.url('../secret')).toBe('')
	} finally {
		client.state.webOrigin = origin
		webLinks.localToken = localToken
	}
})

test('remote links use the connected host and existing auth token, never a different advertised host', () => {
	const origin = client.state.webOrigin
	const remote = webConnection.state.remote
	try {
		webConnection.state.remote = { host: 'hal.antti.dev', authToken: 'remoteToken1' }
		client.state.webOrigin = 'https://another.example'
		expect(webLinks.url('05-wan', 'tool-1')).toBe('https://hal.antti.dev/05-wan?auth=remoteToken1#tool=tool-1')
		client.state.webOrigin = 'https://hal.antti.dev'
		expect(webLinks.url('05-wan')).toBe('https://hal.antti.dev/05-wan?auth=remoteToken1')
		expect(webLinks.imageUrl('05-wan', '000123-abc')).toBe('https://hal.antti.dev/images/05-wan/000123-abc?auth=remoteToken1')
	} finally {
		client.state.webOrigin = origin
		webConnection.state.remote = remote
	}
})
