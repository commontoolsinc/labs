Create a subagent and use ultrathinking within the agent to preserve our context window.

# Research Task

Research objective: $ARGUMENTS

Research the codebase to find out the answer. When I say research, this means first explore the README.md, CLAUDE.md, recent git history, github issues and pr's via the `gh` CLI or the `lr` (linear.app) CLI to understand if this question has been changed recently, then explore as much of the codebase as is necessary to get a thorough understanding of the answer to the question. Consider reading the tests as a way of understanding what features and assertions we already make about the codebase, and we should understand if the tests are passing if the research question is implicitly covered by one of the test cases.

The `ct` binary can be used to research the production environment, see `./claude/commands/common/research.md`

When you do ask questions, provide specific context about what you've already tried and what exactly you're blocked on.

For business domain questions, find the canonical documentation first (wikis, architecture decision records, design docs), then talk to the person who owns that area - not just whoever's available. Record answers in a searchable place so the next person doesn't have to ask again.

The key is minimizing interruptions while maximizing information quality - exhaust self-service options before tapping human knowledge.

# Output

Write the results in `research/YYYYMMDD_QUESTION.md` where the filename is dynamic.
