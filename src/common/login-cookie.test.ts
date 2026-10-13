import { expect, test } from 'bun:test'
import { loginCookie } from './login-cookie.ts'

test('the login cookie is hal on the default ports, else hal-<port>', () => {
	expect(loginCookie('http://localhost:9001')).toBe('hal')
	expect(loginCookie('http://localhost:9002')).toBe('hal-9002')
	expect(loginCookie('http://localhost')).toBe('hal-80')
	expect(loginCookie('https://example.com')).toBe('hal')
	expect(loginCookie('https://example.com:443')).toBe('hal')
	expect(loginCookie('https://example.com:1234')).toBe('hal-1234')
})
