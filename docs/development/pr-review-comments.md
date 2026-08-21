# Reading review comments on a pull request

An automated reviewer posts its findings as inline review comments: each one is
attached to a file and a line of the diff. This document names the commands
that list those findings, and at the end the command that looks as though it
would and does not.

## Listing the findings

This returns every inline review comment on a pull request, with the file and
line each is attached to:

```bash
gh api repos/commontoolsinc/labs/pulls/<n>/comments
```

A finding whose line has since changed comes back with `line` set to null. The
`path` still identifies the file.

## Checking whether a thread is still open

This reports, for each thread, whether it is resolved and whether it is
outdated because the code beneath it moved:

```bash
gh api graphql -f query='
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{ isResolved isOutdated path line comments(first:10){ nodes{ author{login} body } } }
      }
    }
  }
}' -f owner=commontoolsinc -f repo=labs -F number=<n>
```

An unresolved thread is one still waiting on you. An outdated thread may still
be waiting on you: the code moved, which is not the same as the finding being
answered.

## Waiting for the review

Cubic reviews nearly every pull request in this repository. It is configured by
[`cubic.yaml`](../../cubic.yaml) at the repository root, which points it at the
same guidance the `/cf-review` skill and human reviewers use, and it posts as
`cubic-dev-ai[bot]`. The Codex connector reviews a minority of pull requests
and posts as `chatgpt-codex-connector[bot]`.

Cubic's review arrives a few minutes after a push, so it can be absent simply
because it has not run yet. Wait for it before concluding a pull request has no
findings. A push that adds commits starts a fresh review, so the wait applies
again each time.

Take the feedback into account and leave a comment if you disagree, as
[the contributing section of the root `README.md`](../../README.md#contributing)
requires.

## Why `gh pr view` shows nothing

Neither of these returns inline review comments:

```bash
gh pr view <n> --json comments,reviews
gh pr view <n> --comments
```

`comments` holds the issue-comment timeline, which is the conversation at the
bottom of the pull request. Inline findings are not in it, so it is frequently
an empty list on a pull request that has several. `reviews` holds one entry per
submitted review, carrying that review's summary body and not the individual
comments it contains. A summary body is a claim about the findings rather than
the findings themselves, and cubic's says every issue was addressed once its
threads are resolved, so reading it in place of the findings can turn an open
one into a clean bill of health.
