---
name: write-tests
description: Write or extend automated tests for code. Use when the user asks for tests or test coverage of a function, module or bug fix.
---

1. Find the existing test setup: Glob for `*test*`, `*spec*`, check package.json / pyproject / Cargo.toml for the runner. Follow the existing style and location exactly.
2. Read the code under test and list behaviours: normal cases, edge cases (empty, zero, large, unicode, None/null), error cases.
3. Write focused tests, one behaviour each, with descriptive names. No network or real external services; use the project's existing fakes/fixtures.
4. Run the new tests. They must pass — or, for a bug, fail before the fix and pass after.
5. Report what is covered and anything deliberately left out.
