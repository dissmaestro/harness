---
name: commit
description: Create a git commit with a conventional-commit message. Use when the user asks to commit changes.
---

1. Run `git status` and `git diff --staged` (and `git diff` if nothing is staged).
2. If nothing is staged, stage only the files that belong to this change: `git add <files>`. Never `git add -A` blindly; leave unrelated files alone and mention them.
3. Message format (Conventional Commits): `type(scope): summary` — types: feat, fix, refactor, docs, test, chore, perf. Imperative mood, ≤ 72 chars. Add a short body only if the "why" is not obvious.
4. `git commit -m "<message>"`, then show `git log -1 --oneline`.
5. Never push, amend or rewrite history unless the user explicitly asks.
