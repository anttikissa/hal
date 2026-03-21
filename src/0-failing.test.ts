import { test } from "bun:test"

test("✗ Run ./test instead of bun test", () => {
	throw new Error("Run ./test instead of bun test")
})
