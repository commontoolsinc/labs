# Diagnose Issue Command

A command to analyze a GitHub issue and provide detailed diagnosis with Claude assistance.

## Usage

```
claude diagnose <issue-number>
```

## Process

1. **Fetch issue details**:
   ```
   gh issue view <issue-number> --json number,title,body,url,labels,state,createdAt,comments
   ```

2. **Format issue information**:
   - Extract issue title, description, URL, state, creation date
   - Format labels and comments for readability

3. **Present to Claude**:
   - Show Claude the formatted issue details
   - Ask Claude to explore the codebase for relevant files/code
   - Request analysis including problem summary, affected code, root causes, and solutions

4. **Generate diagnosis**:
   - Claude analyzes the issue and codebase
   - Claude produces a comprehensive diagnosis formatted for GitHub

5. **Post comment (optional)**:
   ```
   gh issue comment <issue-number> --body "<diagnosis>"
   ```

## Example Conversation

```
User: claude diagnose 789

Claude: I'll help diagnose GitHub issue #789. First, let me fetch the issue details.
        [Fetches issue with GitHub CLI]

Claude: Here are the details for issue #789: "Button click not working on mobile"
        [Shows formatted issue details]

        I'll now explore the codebase to find relevant files and code that might be related to this issue.
        [Claude explores codebase using tools]

        Based on my exploration, here's my diagnosis:

        ## Problem Summary
        The button click handler isn't triggering on mobile devices due to touch event handling issues.

        ## Affected Code
        - `src/components/Button.tsx`: Uses onClick but not onTouch events
        - `src/utils/eventHandlers.ts`: Missing mobile touch handling

        ## Root Causes
        1. The event listener only handles mouse clicks, not touch events
        2. Touch event propagation is being stopped elsewhere in the code

        ## Proposed Solutions
        1. Add touch event handlers to the Button component
        2. Refactor event handling to use a unified approach for both click and touch
        3. Ensure event propagation isn't being blocked

        [Further technical details and specific code changes]

Claude: Based on my analysis above, would you like me to post this diagnosis as a comment on the GitHub issue?

User: Yes, please post it.

Claude: [Posts comment to GitHub issue]
        Successfully added diagnosis as a comment to issue #789.
```
