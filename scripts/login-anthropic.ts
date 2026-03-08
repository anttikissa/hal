#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "fs"
import { parse, stringify } from "../src/utils/ason.ts"

const HAL_DIR = import.meta.dir + "/.."
const AUTH_PATH = `${HAL_DIR}/auth.ason`
function loadAuth(): any { try { return parse(readFileSync(AUTH_PATH, "utf-8")) } catch { return {} } }
function saveAuth(auth: any) { writeFileSync(AUTH_PATH, stringify(auth) + "\n") }

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

async function generatePKCE() {
	const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)))
		.map(b => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62])
		.join("")
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
	const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
	return { verifier, challenge }
}

const pkce = await generatePKCE()
const url = new URL("https://claude.ai/oauth/authorize")
url.searchParams.set("code", "true")
url.searchParams.set("client_id", CLIENT_ID)
url.searchParams.set("response_type", "code")
url.searchParams.set("redirect_uri", "https://console.anthropic.com/oauth/code/callback")
url.searchParams.set("scope", "org:create_api_key user:profile user:inference")
url.searchParams.set("code_challenge", pkce.challenge)
url.searchParams.set("code_challenge_method", "S256")
url.searchParams.set("state", pkce.verifier)

console.log("Open this URL:\n" + url.toString() + "\n")
const code = prompt("Paste authorization code:")
if (!code) process.exit(1)

const [authCode, state] = code.split("#")
const res = await fetch("https://console.anthropic.com/v1/oauth/token", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		code: authCode, state, grant_type: "authorization_code",
		client_id: CLIENT_ID,
		redirect_uri: "https://console.anthropic.com/oauth/code/callback",
		code_verifier: pkce.verifier,
	}),
})

if (!res.ok) { console.log("Auth failed:", await res.text()); process.exit(1) }
const { access_token, refresh_token, expires_in } = await res.json() as any

const auth = loadAuth()
auth.anthropic = {
	accessToken: access_token,
	refreshToken: refresh_token,
	expires: Date.now() + expires_in * 1000,
}
saveAuth(auth)
console.log(`\nSaved to auth.ason (expires in ${Math.round(expires_in / 60)}min)`)
console.log("Run `./run` to start HAL with Anthropic.\n")
