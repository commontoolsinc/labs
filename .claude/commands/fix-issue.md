# Fix Issue Command

A command to create a branch and fix a GitHub issue with Claude assistance.

## Usage

```
claude fix-issue <issue-number>
```

## Process

1. **Fetch issue details**:
   ```
   gh issue view <issue-number> --json number,title,body,url,labels,assignees,state,createdAt,updatedAt,milestone,comments
   ```

2. **Create a branch**:
   ```
   git checkout -b fix/claude-<issue-number>
   ```

3. **Present the issue to Claude**:
   - Format all issue details (title, description, comments, labels, assignees,
     etc.)
   - Ask Claude to analyze the issue and suggest fixes

4. **Implement changes**:
   - Make code changes based on Claude's suggestions
   - Stage changes with `git add`

5. **Generate PR description**:
   - Fetch the staged changes with `git diff --staged`
   - Ask Claude to analyze changes and create a PR description

6. **Commit and create PR**:
   ```
   git commit -m "Fix #<issue-number>: <issue-title>"
   git push -u origin fix/claude-<issue-number>
   gh pr create --title "Fix #<issue-number>: <issue-title>" --body "<PR description>"
   ```

## Example Conversation

```
User: claude fix-issue 123

Claude: I'll help you fix GitHub issue #123. First, let me fetch the issue details.
        [Fetches issue with GitHub CLI]

Claude: Created branch: fix/claude-123

        Here's the full issue information:
        [Shows formatted issue details]

        Please analyze all the information above and provide a complete fix for this issue.
        Explain your approach and any considerations.

        [Claude and user work together on implementing fixes]

Claude: Once you have implemented and staged the changes, let me know, and I'll help create a PR description and submit the PR.

User: I've staged the changes.

Claude: Let me get the changes for the PR description...
        [Shows diff of staged changes]

        I'll create a summary for the PR description based on these changes.
        [Creates PR description]

        Changes have been committed. When you're ready to create the PR, please provide the PR description you'd like to use.

User: Use the PR description you suggested.

Claude: [Creates PR with GitHub CLI]
        Successfully created branch and committed changes for issue #123.
```
