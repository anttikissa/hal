# Task 8 notes

- The ason.md example is wrong: `/* block comments /*` never closes.
  The old parser silently swallowed the rest of the input; ours throws
  "Unterminated comment". Fix the doc example if you copy it.
- `parseAll` is all-or-nothing: a torn last ASONL record makes it
  throw. Code that must recover a partial tail (session history) has
  to parse line by line or catch and drop the last record.
- Smart-mode width counts each tab as 2 columns (kept from the old
  two-space layout), so wrapping points are part of the exact-output
  contract. Don't "fix" it to 4 or 8 without updating tests.
