# Claude CLI Commands for GitHub Workflows

This directory contains documentation for using Claude to help with GitHub issue and PR workflows. Instead of using shell scripts to control Claude, Claude can now compose these commands directly.

## Available Commands

### fix-issue

Create a branch and fix a GitHub issue with Claude assistance.

```bash
claude fix-issue 123  # Where 123 is the issue number
```

See [fix-issue.md](./fix-issue.md) for detailed process documentation.

### fix-pr

Check out and improve a GitHub pull request with Claude assistance.

```bash
claude fix-pr 456  # Where 456 is the PR number
```

See [fix-pr.md](./fix-pr.md) for detailed process documentation.

### diagnose

Analyze a GitHub issue and provide detailed diagnosis.

```bash
claude diagnose 789  # Where 789 is the issue number
```

See [diagnose.md](./diagnose.md) for detailed process documentation.

## Benefits of This Approach

1. **More Natural Interaction**: Instead of having shell scripts control Claude, Claude can now directly perform these workflows in conversation.

2. **Improved Customization**: Easier to tailor the process to specific scenarios during the conversation.

3. **Better Context Handling**: Claude maintains conversation context instead of relying on temporary files.

4. **Simplified Command Structure**: No need to manage temporary files or complex shell script logic.

## Requirements

- GitHub CLI (`gh`) must be installed and authenticated
- Git must be configured for the repository
- You must have appropriate permissions for the repository

## Usage Tips

- When working with issues or PRs, always provide the issue/PR number as an argument
- Follow Claude's prompts to work through the process step by step
- You can interrupt or modify the workflow at any point during the conversation
