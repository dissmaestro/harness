---
name: web-research
description: Research a question on the internet (docs, library versions, error messages, comparisons) and answer with sources. Use when the answer may be newer than your knowledge.
---

1. For anything that needs more than one or two pages, delegate to the `web-researcher` subagent with the Agent tool — it keeps page contents out of your context. Give it the exact question and what to report.
2. Doing it yourself: load the tools with ToolSearch `select:WebSearch,WebFetch`, then call them with UseTool.
3. Search with specific queries (library name + version + exact error text). Try 2–3 phrasings if results are poor.
4. Prefer primary sources: official docs, GitHub repos/issues, changelogs. Read pages with WebFetch; use `start` to page through long ones.
5. Answer concisely and list the source URLs you actually used. Say when sources disagree or information may be outdated.
