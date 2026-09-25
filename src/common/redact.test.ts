import { expect, test } from 'bun:test'
import { redaction } from './redact.ts'

const secret = 'sk-ant-oat01-AbCdEf0123456789_xyzXYZ-987654321'
const opaque = 'Zq8vN3pLr0Xw2yT5'

test('provider keys and tokens never survive, in any common format', () => {
	let leaks = [
		`request failed with key ${secret}`,
		`{ accessToken: '${opaque}', model: 'x' }`,
		`{"refresh_token":"${opaque}","expires":1}`,
		`x-api-key: ${opaque}`,
		`Authorization: Bearer ${opaque}`,
		`GET /v1?api_key=${opaque}&beta=1`,
		`client_secret=${opaque}`,
		`jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.${opaque}`,
		`token ghp_${opaque}${opaque}`,
	]
	for (let line of leaks) {
		let out = redaction.redact(line)
		expect(out).not.toContain(opaque)
		expect(out).not.toContain(secret)
		expect(out).toContain('[redacted]')
	}
})

test('surrounding text is kept so diagnostics stay useful', () => {
	expect(redaction.redact(`{"refresh_token":"${opaque}","expires":1}`)).toBe('{"refresh_token":"[redacted]","expires":1}')
	expect(redaction.redact(`GET /v1?api_key=${opaque}&beta=1`)).toBe('GET /v1?api_key=[redacted]&beta=1')
	expect(redaction.redact(`status 401 for ${secret} at 12:00`)).toBe('status 401 for [redacted] at 12:00')
})

test('ordinary text is untouched', () => {
	let plain = 'host started, 3 sessions, model claude-opus-4, input_tokens: 1234 disk-key missing'
	expect(redaction.redact(plain)).toBe(plain)
})
