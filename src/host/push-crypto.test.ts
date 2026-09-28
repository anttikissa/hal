import { expect, test } from 'bun:test'
import { pushCrypto } from './push-crypto.ts'

const b = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

test('RFC 8291 §5 vector: authenticated record decrypts to original plaintext', async () => {
	let receiver = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
	let sender = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'
	let publicKey = await crypto.subtle.importKey('raw', b(sender), { name: 'ECDH', namedCurve: 'P-256' }, true, [])
	let jwk = await crypto.subtle.exportKey('jwk', publicKey)
	jwk.d = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'
	jwk.key_ops = ['deriveBits']
	let body = await pushCrypto.encrypt('When I grow up, I want to be a watermelon', { p256dh: receiver, auth: 'BTBZMqHH6r4Tts7J_aSIgg' }, { salt: b('DGv6ra1nlYgDCS1FRnbzlw'), privateKey: jwk })
expect(body.slice(0, 16)).toEqual(b('DGv6ra1nlYgDCS1FRnbzlw'))
	expect(new DataView(body.buffer).getUint32(16)).toBe(4096)
	expect(body.slice(21, 86)).toEqual(b(sender))
	expect(body.slice(86)).toEqual(b('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ'))
})

test('VAPID signs an ES256 JWT for only the push endpoint origin', async () => {
	let keys = await pushCrypto.generate()
	let header = await pushCrypto.vapid('https://push.example.net:443/secret?q=1', keys, 'https://example.com')
	let m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)
	expect(m).not.toBeNull()
	let claims = JSON.parse(Buffer.from(m![2]!, 'base64url').toString())
	expect(claims.aud).toBe('https://push.example.net')
	expect(claims.exp - Date.now() / 1000).toBeLessThan(86400)
	expect(claims.sub).toBe('https://example.com')
	let publicKey = await crypto.subtle.importKey('raw', b(m![4]!), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
	expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, b(m![3]!), new TextEncoder().encode(`${m![1]}.${m![2]}`))).toBe(true)
})
