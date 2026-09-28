// RFC 8291 aes128gcm single-record web push and RFC 8292 VAPID.
// Signing and ephemeral ECDH MUST use different P-256 keys.
export type VapidKeys = { publicKey: string; privateKey: JsonWebKey }
export type PushKeys = { p256dh: string; auth: string }

const bytes = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(value, 'base64url'))
const base64 = (value: Uint8Array | ArrayBuffer): string => Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString('base64url')
const join = (...values: Uint8Array[]): Uint8Array<ArrayBuffer> => {
	let out = new Uint8Array(values.reduce((n, v) => n + v.length, 0))
	let i = 0
	for (let v of values) { out.set(v, i); i += v.length }
	return out
}
const utf8 = (value: string) => new TextEncoder().encode(value)
const point = (jwk: JsonWebKey) => join(new Uint8Array([4]), bytes(jwk.x!), bytes(jwk.y!))

async function generate(): Promise<VapidKeys> {
	let pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
	return { publicKey: base64(point(await crypto.subtle.exportKey('jwk', pair.publicKey))), privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) }
}

// JWS ES256 in WebCrypto is already the 64-byte R || S form (not DER).
async function vapid(endpoint: string, keys: VapidKeys, subject: string): Promise<string> {
	let url = new URL(endpoint)
	let aud = url.origin
	let claims = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }
	let input = `${base64(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))}.${base64(utf8(JSON.stringify(claims)))}`
	let key = await crypto.subtle.importKey('jwk', keys.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
	let signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(input))
	return `vapid t=${input}.${base64(signature)}, k=${keys.publicKey}`
}

// HKDF-Extract/Expand with one block (all outputs <= 32 bytes).
async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array<ArrayBuffer>> {
	let key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	let prk = await crypto.subtle.sign('HMAC', key, ikm)
	key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	return new Uint8Array((await crypto.subtle.sign('HMAC', key, join(info, new Uint8Array([1])))).slice(0, length))
}

async function encrypt(text: string, subscription: PushKeys, options?: { salt: Uint8Array; privateKey: JsonWebKey }): Promise<Uint8Array<ArrayBuffer>> {
	let receiver = bytes(subscription.p256dh)
	let auth = bytes(subscription.auth)
	if (receiver.length !== 65 || receiver[0] !== 4 || auth.length !== 16) throw new Error('invalid push subscription keys')
	let pub = await crypto.subtle.importKey('raw', receiver, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
	let pair = options ? {
		privateKey: await crypto.subtle.importKey('jwk', options.privateKey, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
		publicKey: point(options.privateKey),
	} : await (async () => {
		let keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
		return { privateKey: keys.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)) }
	})()
	let salt = options ? new Uint8Array(options.salt) : crypto.getRandomValues(new Uint8Array(16))
	if (salt.length !== 16) throw new Error('invalid push salt')
	let secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, pair.privateKey, 256))
	let ikm = await hkdf(auth, secret, join(utf8('WebPush: info'), new Uint8Array([0]), receiver, pair.publicKey), 32)
	let cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
	let nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)
	let plain = join(utf8(text), new Uint8Array([2]))
	// RFC 8291 requires rs strictly greater than plaintext + delimiter + tag.
	let size = 4096
	if (86 + plain.length + 16 > size) throw new Error('push payload exceeds 4 KB')
	let header = new Uint8Array(21)
	header.set(salt)
	new DataView(header.buffer).setUint32(16, size)
	header[20] = pair.publicKey.length
	let aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
	return join(header, pair.publicKey, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain)))
}

export const pushCrypto = { generate, vapid, hkdf, encrypt }
