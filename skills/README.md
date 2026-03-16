# Common Fabric Skills

This directory is the canonical source of truth for repo-local skills.

Each skill lives in `skills/<name>/` and may include:

- `SKILL.md`
- `references/`
- `templates/`
- helper scripts or other assets

Compatibility surfaces:

- `/.claude/skills/` preserves the existing Claude-facing skill paths
- `/.agents/skills/` is a compatibility mirror for older internal references

When a skill is conceptually referenced in docs, prefer `skills/<name>/` unless
the reference is specifically about Claude adapter behavior.
