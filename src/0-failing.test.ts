import { test, expect } from "bun:test"

test("this test should fail - run tests with ./test, not bun test", () => {
	expect(true).toBe(false)
})
