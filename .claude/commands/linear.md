# Linear + GitHub Workflow - Session Foundation

This document establishes your working context for Linear-driven development with GitHub integration. It runs at the start of each session to set up proper workflows and mental models.

## ⚠️ CRITICAL: Always Follow This Workflow

### For ANY Implementation Task:
1. Create worktree
2. Check for conflicts  
3. Update Linear status
4. Use specialized agent
5. Let agent handle PR

## 🎯 Direct Command Responses

When user says: **"let's fix CT-XXX"**
You MUST respond with: "I'll help you fix CT-XXX. Let me set up the proper workflow first."
Then execute these steps:

```javascript
// When user says "let's fix CT-XXX", ALWAYS start with:
const issue = await mcp__linear-server__get_issue({ id: "CT-XXX" });

// 1. Create worktree FIRST
await Bash({ command: "cd /Users/ben/code/labs && git worktree add labs-ct-xxx -b fix/2025-MM-DD-ct-xxx-brief-description" });

// 2. Check for conflicts
await Bash({ command: "gh pr list | grep -i ct-xxx" });

// 3. Update status
await mcp__linear-server__update_issue({ id: issue.id, stateId: inProgressId });

// 4. THEN delegate to implementation agent
await Task({
  description: "Fix issue CT-XXX",
  subagent_type: "plan-implementer", 
  prompt: `Fix the issue described in Linear issue ${issue.identifier}...`
});
```

When user says: **"can you implement..."**  
You MUST respond with: "I'll set up the workflow and delegate this to the appropriate implementation agent."

**NEVER jump directly to: Read, Edit, MultiEdit, or Write tools**

## 🚀 Quick Session Startup

When the `/linear` command is run WITHOUT a specific issue:

```javascript
// 1. Check your active issues
const myIssues = await mcp__linear-server__list_my_issues({ limit: 50 });

// 2. Group by status for overview
const inProgress = myIssues.filter(i => i.state?.name === "In Progress");
const inReview = myIssues.filter(i => i.state?.name === "In Review");

// 3. Present concise summary
"Linear Status:
- In Progress (3): CT-701, CT-703, CT-705
- In Review (2): CT-699, CT-700

What would you like to focus on today?"
```

### STOP! Pre-Work Checklist (MANDATORY)
When starting work on a specific issue:
- [ ] Have you created a git worktree for this issue?
- [ ] Have you checked for concurrent work (gh pr list, git worktree list)?
- [ ] Have you updated the Linear issue status to "In Progress"?
- [ ] Have you created a TodoWrite list for tracking?

⚠️ **DO NOT PROCEED TO CODE UNTIL ALL BOXES ARE CHECKED**

### Finding Your Team ID
```javascript
// List all teams to find your team ID
const teams = await mcp__linear-server__list_teams({});
// Common team ID: "b75d85d3-3e07-4ed3-b876-619ee103cad3" (CommonTools)
```

## 🎯 Core Working Principles

### 1. Issue-First Development
**ALWAYS** check for existing issues before implementing anything:
```javascript
// Before ANY work, search for related issues
await mcp__linear-server__list_issues({
  query: "websocket authentication",
  teamId: "your-team-id"
});

// No issue found? Create one FIRST
await mcp__linear-server__create_issue({
  title: "Add WebSocket authentication",
  description: "Clear description with acceptance criteria...",
  teamId: "team-id",
  priority: 3  // 1=Urgent🔴, 2=High🟠, 3=Normal🟡, 4=Low
});
```

### 2. Linear as Persistent Memory
**Use Linear over TodoWrite() for anything substantial:**
- Linear persists between sessions
- Provides audit trail and collaboration
- Integrates with GitHub PRs
- TodoWrite() is only for quick, ephemeral lists

### 3. Branch-Issue-PR Trinity
Every feature follows this pattern:
```bash
# 1. Linear issue exists (CT-703)
# 2. Create branch with issue ID
git checkout -b feat/2025-07-31-ct-703-websocket-auth

# 3. Create PR with issue reference
gh pr create --title "Add WebSocket auth [CT-703]" --body "Closes CT-703..."
```

### 4. Working Safely with Multiple Agents
Since multiple agents/users may work on the same repo simultaneously:

**Use Git Worktrees for Isolation:**
```bash
# Create isolated worktree for your issue
git worktree add ../labs-ct-703 -b feat/2025-07-31-ct-703-websocket-auth

# Work in the isolated directory
cd ../labs-ct-703

# This prevents conflicts with other agents working on main or other branches
```

**Always Check Before Starting:**
```bash
# See who else might be working
gh pr list
git worktree list
git branch -r | grep -E "(in-progress|wip)"

# Check if someone is already on your issue
await mcp__linear-server__get_issue({ id: "issue-id" });
// Look for "In Progress" status or recent comments
```

**Benefits of Worktrees:**
- Prevents "files changed on disk" conflicts
- No interference between concurrent work
- Each agent has isolated file state
- Shared git history for coordination

## 📋 Status Workflow

Issues flow through these states:
```
Triage → On Deck → In Progress → In Review → Done
```

Update status immediately when:
- Starting work: → In Progress
- Creating PR: → In Review  
- PR merged: → Done

## 🔧 Essential Commands

### Linear Core Operations
```javascript
// Find issues
mcp__linear-server__list_my_issues({ limit: 20 })
mcp__linear-server__list_issues({ query: "search", teamId: "id" })
mcp__linear-server__get_issue({ id: "issue-id" })

// Create & update
mcp__linear-server__create_issue({ title, description, teamId, priority })
mcp__linear-server__update_issue({ id, stateId })
mcp__linear-server__create_comment({ issueId, body })

// Get status IDs
mcp__linear-server__list_issue_statuses({ teamId })
```

### GitHub Integration
```bash
# Branch from issue
git checkout -b feat/YYYY-MM-DD-ct-XXX-description

# Create PR with Linear link
gh pr create --title "Title [CT-XXX]" --body "Closes CT-XXX..."

# Check and merge
gh pr checks
gh pr merge --squash --delete-branch
```

## 🏃 Complete Workflow Example

Here's the full cycle from issue to completion:

```javascript
// 1. Find or create issue
const issues = await mcp__linear-server__list_issues({ 
  query: "memory leak websocket" 
});

// 2. Create if needed
const issue = await mcp__linear-server__create_issue({
  title: "Fix WebSocket memory leak",
  description: "Event listeners not being cleaned up...",
  teamId: "team-id",
  priority: 2  // High priority
});

// 3. Start work - update status
const statuses = await mcp__linear-server__list_issue_statuses({ teamId });
const inProgress = statuses.find(s => s.name === "In Progress");
await mcp__linear-server__update_issue({ 
  id: issue.id, 
  stateId: inProgress.id 
});
```

```bash
# 4. Create branch and implement
git checkout -b fix/2025-07-31-ct-704-memory-leak
# ... make changes ...
git add .
git commit -m "fix: clean up WebSocket event listeners

- Remove listeners on disconnect
- Clear connection references
- Add cleanup tests

Fixes CT-704"

# 5. Push and create PR
git push -u origin fix/2025-07-31-ct-704-memory-leak
gh pr create --title "Fix WebSocket memory leak [CT-704]" --body "$(cat <<'EOF'
## Summary
- Fixed memory leak by cleaning up event listeners
- Added proper disconnect handling

Closes CT-704

## Test Plan
- [x] Unit tests pass
- [x] Memory profiler shows stable usage
EOF
)"
```

```javascript
// 6. Update Linear to "In Review"
const inReview = statuses.find(s => s.name === "In Review");
await mcp__linear-server__update_issue({ 
  id: issue.id, 
  stateId: inReview.id 
});

// 7. After merge, close issue
await mcp__linear-server__update_issue({ 
  id: issue.id, 
  stateId: doneState.id 
});
```

## 🤝 Working with Specialized Agents

Delegate complex tasks to specialized agents based on the work type:

### When to Use Agents

**Implementation Tasks** - When you have a clear plan to execute:
```javascript
await Task({
  description: "Implement WebSocket auth",
  subagent_type: "implementation-agent", // Use your available implementation agent
  prompt: `Implement JWT authentication for WebSocket server as described in Linear issue ${issue.identifier}. 
  Follow the acceptance criteria and ensure all tests pass.`
});
```

**Planning & Architecture** - For breaking down complex problems:
```javascript
await Task({
  description: "Plan refactoring strategy",
  subagent_type: "planning-agent", // Use your available planning agent
  prompt: `Create a detailed plan for refactoring the authentication system. 
  Break down into incremental steps without implementing.`
});
```

**Debugging & Investigation** - For systematic problem-solving:
```javascript
await Task({
  description: "Debug memory leak",
  subagent_type: "debugging-agent", // Use your available debugging agent
  prompt: `Investigate memory leak described in Linear issue ${issue.identifier}. 
  Find root cause and propose fix.`
});
```

**Code Research** - For understanding existing implementations:
```javascript
await Task({
  description: "Research auth patterns",
  subagent_type: "research-agent", // Use your available research agent
  prompt: `Research how authentication is currently implemented across the codebase. 
  Document patterns and conventions.`
});
```

**Key principle: Always include Linear issue context in agent prompts for continuity.**

## ❌ Common Mistakes to Avoid

### The "Quick Fix" Trap
**Mistake**: "This looks simple, I'll just fix it quickly"
**Why it's bad**: Skips workflow, causes conflicts, inconsistent approach
**Instead**: ALWAYS use worktrees and agents, even for "simple" fixes

### The "Already in the Right Directory" Fallacy  
**Mistake**: "I'm already in packages/ui, so I'll just work here"
**Why it's bad**: Conflicts with other agents/users, no isolation
**Instead**: Create a fresh worktree for EVERY issue

### The "I Can Do It Myself" Syndrome
**Mistake**: Implementing directly instead of using specialized agents
**Why it's bad**: Misses domain knowledge, patterns, and optimizations
**Instead**: Delegate to agents - they have specialized knowledge

## 🎨 Best Practices

### Issue Management
- Clear, searchable titles with component names
- Include reproduction steps for bugs
- Add acceptance criteria for features
- Link related issues via comments
- Update status in real-time

### Branch Naming
- `feat/YYYY-MM-DD-ct-XXX-brief-description` - New features
- `fix/YYYY-MM-DD-ct-XXX-brief-description` - Bug fixes
- `refactor/YYYY-MM-DD-ct-XXX-brief-description` - Refactoring
- Always include the Linear issue ID

### PR Practices
- Title: "Clear description [CT-XXX]"
- Body: Include "Closes CT-XXX" for auto-close
- Reference specific commits if addressing multiple issues
- Request reviews via `gh pr edit --add-reviewer @user`

### Comment Strategy
Document in Linear:
- Decisions and rationale
- Blockers or dependencies  
- PR links
- Completion summary

## 📌 Quick Reference Card

### Priority Levels
- 0 = No priority
- 1 = Urgent 🔴
- 2 = High 🟠  
- 3 = Normal 🟡
- 4 = Low

### Common Patterns
```bash
# See all your PRs
gh pr status

# Check CI status
gh pr checks

# View issue in browser
gh issue view CT-XXX --web

# Add team labels
gh pr edit --add-label "bug,high-priority"
```

### Progressive Context Loading
1. **Level 1** (startup): Issue status overview
2. **Level 2** (task start): Full issue details + comments
3. **Level 3** (deep work): Related docs + codebase research

## 🚨 Common Issues & Solutions

### Linear API Issues
```javascript
// If team ID is unknown
const teams = await mcp__linear-server__list_teams({});
const team = teams.find(t => t.name === "Your Team Name");

// If status names don't match exactly
const statuses = await mcp__linear-server__list_issue_statuses({ teamId });
console.log(statuses.map(s => ({ id: s.id, name: s.name })));

// If issue not found
const issues = await mcp__linear-server__list_issues({ 
  query: "partial title keywords",
  includeArchived: true 
});
```

### GitHub CLI Issues
```bash
# PR creation fails - check branch is pushed
git push -u origin branch-name

# Merge conflicts
gh pr view  # Check PR status
git pull origin main
git merge main
# Resolve conflicts, then:
git add .
git commit -m "resolve: merge conflicts with main"
git push

# CI failures
gh pr checks  # See which checks failed
gh run view   # Get detailed logs
```

### Integration Issues
- **PR not linking to Linear**: Ensure `[CT-XXX]` is in PR title
- **Issue not auto-closing**: Use "Closes CT-XXX" in PR body
- **Status not syncing**: Manually update via Linear API

## 🔑 Remember

1. **Check Linear first, implement second**
2. **One issue = One branch = One PR**
3. **Update status as you progress**
4. **Comment significant findings**
5. **Link everything properly**
6. **Use specialized agents for complex tasks**

This workflow ensures persistent context across sessions, clear audit trails, and seamless Linear-GitHub integration. Your work is always trackable, recoverable, and collaborative.