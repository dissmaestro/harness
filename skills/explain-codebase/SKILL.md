---
name: explain-codebase
description: Explain how a project or a part of it works (architecture, data flow, where things are). Use when the user asks how the code works or where something is implemented.
---

1. Start broad and cheap: README/AGENTS.md, the top-level layout (`Glob` for main source files), build files.
2. For a large codebase, delegate the exploration to the `explore` subagent with a precise question, so file contents stay out of your context.
3. Find entry points (main, cli, server routes, exported API) and follow the flow the user asked about with Grep and Read.
4. Explain top-down: purpose → main components → how they interact → details the user asked for. Reference `path:line` so the user can jump there.
5. Keep it short; offer to go deeper into any part.
