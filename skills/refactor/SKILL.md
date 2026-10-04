---
name: refactor
description: Restructure code without changing behaviour (rename, extract, split, simplify). Use when the user asks to refactor or clean up code.
---

1. Make sure there is a safety net: find and run the relevant tests first. If there are none, say so and suggest writing a few before large changes.
2. Find every usage of what you change (Grep for names, including strings/config files) before editing.
3. Change in small steps; after each step the code must still work. Prefer several small Edits over one big rewrite.
4. Do not mix refactoring with behaviour changes or unrelated cleanups.
5. Run the tests again. Report what changed and confirm behaviour is unchanged.
