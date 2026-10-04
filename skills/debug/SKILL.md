---
name: debug
description: Systematically find the root cause of a bug, failing test or error message. Use when something is broken and the cause is unknown.
---

1. Reproduce first: run the failing command/test and capture the exact error. If you cannot reproduce, say so and ask for details.
2. Read the stack trace from the innermost frame of *project* code. Read that code.
3. Form 1–3 concrete hypotheses. For each, find evidence: Grep usages, Read callers, check recent changes (`git log -p -5 -- <file>`).
4. Narrow down with the cheapest experiment: a print/log, a minimal script, running one test. Remove temporary debug code afterwards.
5. Unknown library error message? Load WebSearch with ToolSearch and search the exact message.
6. Fix the root cause, not the symptom. Keep the change minimal.
7. Re-run the reproduction and the related tests. Report: cause, fix, how it was verified.
