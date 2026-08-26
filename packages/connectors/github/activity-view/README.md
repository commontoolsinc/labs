# GitHub activity view

This pattern fetches recent commits from a public GitHub repository. It shows
the commits as linked cards and uses a language model to summarize the recent
development activity. Changing the repository URL refreshes both the commits and
the summary.

The input is a writable `repoUrl`. It defaults to
`https://github.com/anthropics/claude-code`.
