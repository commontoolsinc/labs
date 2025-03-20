#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write

// Configuration (you can move these to a config file)
const REPO_PATH = Deno.cwd(); // Assumes script is run from repo root
const BRANCH_PREFIX = "fix/claude-";

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
}

interface IssueComment {
  author: { login: string };
  body: string;
  createdAt: string;
}

async function main() {
  try {
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
        "number,title,body,url,labels,assignees,state,createdAt,updatedAt,milestone",
      ],
    });
    const issueOutput = await issueProcess.output();
    if (!issueOutput.success) {
      console.error("Failed to fetch issue details");
      Deno.exit(1);
    }

    const issueJSON = new TextDecoder().decode(issueOutput.stdout);
    const issue: GitHubIssue = JSON.parse(issueJSON);

    // Fetch comments on the issue
    console.log(`Fetching comments for issue #${issueNumber}...`);
    const commentsProcess = new Deno.Command("gh", {
      args: [
        "issue",
        "view",
        issueNumber,
        "--comments",
        "--json",
        "author,body,createdAt",
      ],
    });
    const commentsOutput = await commentsProcess.output();
    let comments: IssueComment[] = [];

    if (commentsOutput.success) {
      const commentsJSON = new TextDecoder().decode(commentsOutput.stdout);
      comments = JSON.parse(commentsJSON);
    } else {
      console.warn(
        "Warning: Failed to fetch comments, proceeding without them",
      );
    }

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
    const promptFile = `${REPO_PATH}/.claude-prompt.tmp`;
    await Deno.writeTextFile(promptFile, fixPrompt);

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

    // Commit the changes
    const commitMessage = `Fix #${issue.number}: ${issue.title}`;
    await new Deno.Command("git", { args: ["add", "."] }).output();
    await new Deno.Command("git", { args: ["commit", "-m", commitMessage] })
      .output();

    // Create the PR
    console.log("Creating PR...");
    const prDescription = `
Fixes #${issue.number}

${prSummary}

This PR was created with Claude Code assistance.
`;

    const prDescFile = `${REPO_PATH}/.pr-desc.tmp`;
    await Deno.writeTextFile(prDescFile, prDescription);

    const prProcess = new Deno.Command("gh", {
      args: [
        "pr",
        "create",
        "--title",
        commitMessage,
        "--body-file",
        prDescFile,
      ],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await prProcess.output();

    // Clean up temporary files
    try {
      await Deno.remove(promptFile);
      await Deno.remove(prDescFile);
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
