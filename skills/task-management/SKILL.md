---
name: task-management
description: Guide for coordinating implementation work through Common Fabric Topics, Linear, and concise handoff notes. Use this skill when breaking down plans into issues, tracking progress, managing dependencies, or coordinating work across sessions and agents. Triggers include requests to "manage tasks", "track progress", "break down this work", or prepare a handoff.
---

# Task Management

Prefer the Common Fabric Topics board for collaborative work that benefits from
a living description, discussion, progress comments, and links. Its deployment,
authorship conventions, and CLI surface are mapped in `skills/topics/SKILL.md`.

Use Linear for organization-level planning and for work that already has a
Linear issue. Keep its status, scope, dependencies, and useful implementation
findings current as work progresses.

Keep temporary planning in the active task. When work genuinely needs to span
sessions or pass between agents, use a short `FOCUS.md` handoff note containing:

- the current objective and scope
- verified facts and relevant commits
- remaining work and dependencies
- blockers or decisions that need user input

Do not add generated tracker state or local task databases to the repository.
