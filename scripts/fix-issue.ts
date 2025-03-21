#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write

// Function to find the git repository root
async function findRepoRoot(): Promise<string> {
  try {
    const gitRootProcess = new Deno.Command("git", {
      args: ["rev-parse", "--show-toplevel"],
    });
    const gitRootOutput = await gitRootProcess.output();

    if (gitRootOutput.success) {
      const repoRoot = new TextDecoder().decode(gitRootOutput.stdout).trim();
      console.log(`Found repository root: ${repoRoot}`);
      return repoRoot;
    } else {
      console.warn(
        "Warning: Could not determine git repository root. Using current directory.",
      );
      return Deno.cwd();
    }
  } catch (error) {
    console.warn("Warning: Error finding git repository root:", error);
    console.warn("Using current directory instead.");
    return Deno.cwd();
  }
}

// Configuration (you can move these to a config file)
let REPO_PATH = Deno.cwd(); // Will be updated to repo root in main()
const BRANCH_PREFIX = "fix/claude-";
// Define temporary files path to exclude from git
let PROMPT_FILE: string;
let PR_DESC_FILE: string;

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
  state: string;
  createdAt: string;
  updatedAt: string;
  milestone?: { title: string };
  comments: IssueComment[];
}

interface IssueComment {
  author: { login: string };
  body: string;
  createdAt: string;
}

async function main() {
  try {
    // Find the repository root
    REPO_PATH = await findRepoRoot();

    // Change to repository root
    Deno.chdir(REPO_PATH);
    console.log(`Working directory changed to repository root: ${REPO_PATH}`);

    // Update file paths now that we have the repo root
    PROMPT_FILE = `${REPO_PATH}/.claude-prompt.tmp`;
    PR_DESC_FILE = `${REPO_PATH}/.pr-desc.tmp`;

    // Get issue number from command line
    const issueNumber = Deno.args[0];
    if (!issueNumber) {
      console.error("Please provide an issue number");
      Deno.exit(1);
    }

    // Fetch comprehensive issue details using GitHub CLI
    console.log(`Fetching issue #${issueNumber}...`);
    const issueProcess = new Deno.Command("gh", {
      args: [
        "issue",
        "view",
        issueNumber,
        "--json",
        "number,title,body,url,labels,assignees,state,createdAt,updatedAt,milestone,comments",
      ],
    });
    const issueOutput = await issueProcess.output();
    if (!issueOutput.success) {
      console.error("Failed to fetch issue details");
      Deno.exit(1);
    }

    const issueJSON = new TextDecoder().decode(issueOutput.stdout);
    const issue: GitHubIssue = JSON.parse(issueJSON);

    // Get comments from the issue object directly
    let comments = issue.comments || [];
    console.log(
      `Retrieved ${comments.length} comments for issue #${issueNumber}`,
    );

    // Create a new branch for the fix
    const branchName = `${BRANCH_PREFIX}${issue.number}`;
    console.log(`Creating branch: ${branchName}`);
    const gitProcess = new Deno.Command("git", {
      args: ["checkout", "-b", branchName],
    });
    const gitOutput = await gitProcess.output();
    if (!gitOutput.success) {
      console.error("Failed to create branch");
      Deno.exit(1);
    }

    // Format labels for the prompt
    const labelsText = issue.labels.length > 0
      ? `Labels: ${issue.labels.map((l) => l.name).join(", ")}`
      : "No labels";

    // Format assignees for the prompt
    const assigneesText = issue.assignees.length > 0
      ? `Assignees: ${issue.assignees.map((a) => a.login).join(", ")}`
      : "No assignees";

    // Format milestone
    const milestoneText = issue.milestone
      ? `Milestone: ${issue.milestone.title}`
      : "No milestone";

    // Format comments for the prompt
    const commentsText = comments.length > 0
      ? comments.map((c) => `
Comment by ${c.author.login} on ${new Date(c.createdAt).toLocaleString()}:
${c.body}
---`).join("\n")
      : "No comments on this issue.";

    // Prepare comprehensive prompt for Claude
    const fixPrompt = `
I need help fixing GitHub issue #${issue.number}: "${issue.title}"

## Issue Details
URL: ${issue.url}
State: ${issue.state}
Created: ${new Date(issue.createdAt).toLocaleString()}
Updated: ${new Date(issue.updatedAt).toLocaleString()}
${labelsText}
${assigneesText}
${milestoneText}

## Description
${issue.body}

## Comments
${commentsText}

Please analyze all the information above and provide a complete fix for this issue.
Explain your approach and any considerations.
`;

    // Store prompt to a temporary file for reference
    await Deno.writeTextFile(PROMPT_FILE, fixPrompt);

    // Invoke Claude Code to fix the issue
    console.log("Invoking Claude Code to analyze and fix the issue...");
    const claudeProcess = new Deno.Command("claude", {
      args: [fixPrompt],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await claudeProcess.output();

    // After fixes are implemented (by the user following Claude's suggestions)
    console.log(
      "\nOnce you have implemented the fixes, press Enter to continue...",
    );

    // Read a line from stdin
    const buf = new Uint8Array(1024);
    await Deno.stdin.read(buf);

    // Get the git diff to show what changes were made
    console.log("Getting changes for PR description...");
    const diffProcess = new Deno.Command("git", {
      args: ["diff", "--staged"],
    });
    const diffOutput = await diffProcess.output();
    let diffText = "No changes detected.";

    if (diffOutput.success) {
      diffText = new TextDecoder().decode(diffOutput.stdout);
    }

    // Ask Claude to summarize the changes for the PR description
    console.log("Asking Claude to summarize changes for PR description...");
    const summaryPrompt = `
I've just implemented a fix for GitHub issue #${issue.number}: "${issue.title}"

Here's the original issue description:
${issue.body}

Here are the changes I made (git diff):
\`\`\`
${diffText}
\`\`\`

Please provide a concise but comprehensive summary of these changes for a pull request description.
Format your response as a PR description with sections for:
1. What was fixed
2. How it was fixed
3. Any important technical details
4. Testing considerations

Keep your response focused on the technical details that would be useful in a PR description.
`;

    // Run Claude to summarize the changes
    const summaryProcess = new Deno.Command("claude", {
      args: ["--print", summaryPrompt],
    });
    const summaryOutput = await summaryProcess.output();
    let prSummary = "Fix implemented with Claude Code assistance.";

    if (summaryOutput.success) {
      prSummary = new TextDecoder().decode(summaryOutput.stdout);
    } else {
      console.warn("Warning: Failed to generate PR summary, using default");
    }

    // Write PR description to a temporary file
    const prDescription = `
Fixes #${issue.number}

${prSummary}

This PR was created with Claude Code assistance.
`;
    await Deno.writeTextFile(PR_DESC_FILE, prDescription);

    // Create a gitignore for temp files before committing
    console.log("Ensuring temporary files are not committed...");

    // Add temp files to .gitignore for this commit only
    const gitIgnoreCmd = new Deno.Command("git", {
      args: ["update-index", "--skip-worktree", PROMPT_FILE, PR_DESC_FILE],
    });
    await gitIgnoreCmd.output();

    // Commit the changes
    const commitMessage = `Fix #${issue.number}: ${issue.title}`;
    await new Deno.Command("git", { args: ["add", "."] }).output();
    await new Deno.Command("git", { args: ["commit", "-m", commitMessage] })
      .output();

    // Create the PR
    console.log("Creating PR...");
    const prProcess = new Deno.Command("gh", {
      args: [
        "pr",
        "create",
        "--title",
        commitMessage,
        "--body-file",
        PR_DESC_FILE,
      ],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await prProcess.output();

    // Unset the skip-worktree flag
    await new Deno.Command("git", {
      args: ["update-index", "--no-skip-worktree", PROMPT_FILE, PR_DESC_FILE],
    }).output();

    // Clean up temporary files
    try {
      await Deno.remove(PROMPT_FILE);
      await Deno.remove(PR_DESC_FILE);
    } catch (error) {
      console.error("Error cleaning up temporary files:", error);
    }

    console.log("Done! PR created successfully.");
  } catch (error) {
    console.error("Error:", error);
    Deno.exit(1);
  }
}

main();
