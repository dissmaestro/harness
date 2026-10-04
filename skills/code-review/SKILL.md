---
name: code-review
description: Review code changes (uncommitted diff, a branch or given files) for bugs and risks. Use when the user asks for a review or to check changes.
---

1. Get the change: `git diff` + `git diff --staged`, or `git diff main...HEAD` for a branch, or the files the user named.
2. For every changed hunk, Read enough surrounding code to understand it. Do not review blind.
3. Look for, in this order:
   - correctness: wrong logic, off-by-one, null/undefined, unhandled errors, races, wrong types;
   - security: injection, secrets in code, unsafe input handling, path traversal;
   - behaviour changes that callers or tests don't expect (Grep for usages);
   - missing tests for new behaviour;
   - leftovers: debug prints, commented-out code, TODOs.
4. Run the project's tests/linters if they exist and are cheap.
5. Report a short list, most severe first: `file:line — problem — why it matters — suggested fix`. Say clearly when you found nothing serious. Do not edit files unless asked.
