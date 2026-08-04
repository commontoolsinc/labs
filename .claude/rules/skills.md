---
paths:
  - "skills/**/*.md"
---

# Authoring a skill

## Edit `skills/`, never the mirrors

`skills/` is the authored source. `.claude/skills/` and `.agents/skills/` are
directories of symlinks into it, so that Claude Code and Codex both find the
same files. An edit made through a mirror path is an edit to the real file, but
a new file created in a mirror is not a skill — it is an untracked file in the
wrong place.

## A skill is a map, not a procedure

Every skill is loaded into context when it is invoked, where it competes with
the task for attention and shapes the agent's thinking before it has looked at
anything. That buys a lot when the skill supplies what an agent cannot derive —
the canonical home for a concept, the exact symbol to import, the value that
has to be passed, the failure that looks like something else. It buys nothing
when the skill spells out a procedure a capable model already follows, and it
costs something, because the procedure ages worse than the model does.

`docs/development/skill-authoring.md` is the standard to write against.

## Load-bearing facts have to be testable

`deno task check-skill-facts` fails when an import specifier or repository path
cited by a skill, an `AGENTS.md`, or a rule stops resolving. Run it after
editing a skill; a file moved elsewhere in the repository is the usual way one
goes stale.

That gate only sees paths and imports, which is half the problem.
`docs/development/skill-audit.md` covers the other half and which mechanism
owns which.
