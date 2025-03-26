#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write

// Get the Git repository root directory
async function getGitRoot(): Promise<string> {
  try {
    const gitRootProcess = new Deno.Command("git", {
      args: ["rev-parse", "--show-toplevel"],
    });
    const gitRootOutput = await gitRootProcess.output();
    if (gitRootOutput.success) {
      return new TextDecoder().decode(gitRootOutput.stdout).trim();
    }
  } catch (error) {
    console.error("Error finding Git root:", error);
  }
  return Deno.cwd(); // Fallback to current directory
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: Array<{ name: string; color: string }>;
  state: string;
  createdAt: string;
  comments: IssueComment[];
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

    // Get the Git repository root
    const REPO_PATH = await getGitRoot();
    console.log(`Repository root: ${REPO_PATH}`);

    // Fetch issue details
    console.log(`Fetching issue #${issueNumber}...`);
    const issueProcess = new Deno.Command("gh", {
      args: [
        "issue",
        "view",
        issueNumber,
        "--json",
        "number,title,body,url,labels,state,createdAt,comments",
      ],
    });
    const issueOutput = await issueProcess.output();
    if (!issueOutput.success) {
      console.error("Failed to fetch issue details");
      Deno.exit(1);
    }

    const issueJSON = new TextDecoder().decode(issueOutput.stdout);
    const issue: GitHubIssue = JSON.parse(issueJSON);

    // Format labels for the prompt
    const labelsText = issue.labels.length > 0
      ? `Labels: ${issue.labels.map((l) => l.name).join(", ")}`
      : "No labels";

    // Format comments for the prompt
    const commentsText = issue.comments.length > 0
      ? issue.comments.map((c) => `
Comment by ${c.author.login} on ${new Date(c.createdAt).toLocaleString()}:
${c.body}
---`).join("\n")
      : "No comments on this issue.";

    // Create temporary directory for files
    const tempDir = `${REPO_PATH}/.claude-${Date.now()}`;
    try {
      await Deno.mkdir(tempDir);
    } catch (error) {
      console.error(`Failed to create temp directory: ${error}`);
      Deno.exit(1);
    }

    // Prepare prompt for Claude Code
    const prompt = `
I need you to diagnose GitHub issue #${issue.number}: "${issue.title}"

## Issue Details
URL: ${issue.url}
State: ${issue.state}
Created: ${new Date(issue.createdAt).toLocaleString()}
${labelsText}

## Description
${issue.body}

## Comments
${commentsText}

You are in a Git repository that contains this issue. Please:

1. Explore the codebase to find relevant files and code that might be related to this issue.
   - Use the 'file' command to see the directory structure
   - Use 'cat' or similar commands to read relevant files
   - Use 'git grep' to search for relevant keywords from the issue

2. Based on your exploration, analyze the issue and:
   - Summarize the problem and provide additional context
   - Identify the relevant parts of the code that are affected
   - Explain potential root causes
   - Propose possible solutions or approaches to fix the issue

Your response will be posted as a comment on the issue, so format it appropriately for GitHub markdown.
Please be thorough in your exploration and insightful in your analysis.

Write your final comment to ${tempDir}/comment.txt
`;

    // Save prompt to a temporary file
    const promptFile = `${tempDir}/prompt.txt`;
    await Deno.writeTextFile(promptFile, prompt);

    // Invoke Claude Code to diagnose the issue
    console.log(
      "Asking Claude Code to analyze the issue and explore the codebase...",
    );
    const claudeProcess = new Deno.Command("claude", {
      args: [prompt],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    // Run the process but don't try to access stdout since it's piped to inherit
    const claudeStatus = await claudeProcess.spawn().status;

    // Check if the comment file was created
    const commentFile = `${tempDir}/comment.txt`;
    let commentFileExists = false;
    try {
      const fileInfo = await Deno.stat(commentFile);
      commentFileExists = fileInfo.isFile;
    } catch {
      commentFileExists = false;
    }

    if (!claudeStatus.success || !commentFileExists) {
      console.error("Failed to generate diagnosis with Claude");
      // Clean up and exit
      await Deno.remove(tempDir, { recursive: true });
      Deno.exit(1);
    }

    // Add comment to the issue
    console.log("Adding diagnosis as a comment to the issue...");

    const commentProcess = new Deno.Command("gh", {
      args: ["issue", "comment", issueNumber, "--body-file", commentFile],
    });
    const commentOutput = await commentProcess.output();
    if (!commentOutput.success) {
      console.error("Failed to add comment to issue");
    }

    // Clean up temporary directory and all files
    try {
      await Deno.remove(tempDir, { recursive: true });
      console.log(`Cleaned up temporary files in ${tempDir}`);
    } catch (error) {
      console.error(`Error cleaning up temporary directory: ${error}`);
    }

    console.log("Done! Diagnosis comment added to the issue.");
  } catch (error) {
    console.error("Error:", error);
    Deno.exit(1);
  }
}

main();
