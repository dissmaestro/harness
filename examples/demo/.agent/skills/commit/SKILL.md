---
name: commit
description: Create a git commit with a conventional-commit message. Use when the user asks to commit changes.
---

# Commit

1. Run `git status` and `git diff --staged` (and `git diff` if nothing is staged) with Bash.
2. If nothing is staged, stage the relevant files with `git add <files>` — never `git add -A` blindly.
3. Write a message in Conventional Commits format: `type(scope): summary` (types: feat, fix, refactor, docs, test, chore).
   Summary in imperative mood, ≤ 72 chars. Add a body only if the "why" isn't obvious.
4. Commit with `git commit -m "<message>"` and show the resulting `git log -1 --oneline`.
