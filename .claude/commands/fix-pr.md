# Fix PR Command

A command to check out and improve a GitHub pull request with Claude assistance.

## Usage

```
claude fix-pr <pr-number>
```

## Process

1. **Fetch PR branch information**:
   ```
   gh pr view <pr-number> --json headRefName
   ```

2. **Checkout the PR branch**:
   ```
   gh pr checkout <pr-number>
   ```

3. **Get PR details**:
   ```
   gh pr view <pr-number> --json body,comments,state,statusCheckRollup,changedFiles
   ```

4. **Get PR diff**:
   ```
   git diff main...HEAD
   ```

5. **Present PR to Claude**:
   - Show the PR description, comments, and code diff
   - Ask Claude to review the PR and suggest improvements

6. **Implement changes**:
   - Make code changes based on Claude's review
   - Stage changes with `git add`

7. **Commit and push**:
   ```
   git commit -m "Apply changes from PR #<pr-number> review"
   git push origin <branch-name>
   ```

## Example Conversation

```
User: claude fix-pr 456

Claude: I'll help you review and fix pull request #456. First, let me fetch the PR details.
        [Fetches PR with GitHub CLI]

Claude: Checking out PR branch: feature/new-widget...
        [Checks out the PR branch]

        Here's the full PR information and diff:
        [Shows PR details and code diff]

        Please review the PR details above and decide if any changes are needed.
        If changes are needed, please provide the exact code changes to implement.
        If no changes are needed, please explain why.

        [Claude and user discuss potential improvements]

Claude: If you want to apply any changes, let me know when you're done, and I'll help commit and push them.

User: I've made the changes you suggested.

Claude: Let me commit and push those changes for you.
        [Commits and pushes changes to PR branch]

        Successfully pushed changes to PR branch.
```
