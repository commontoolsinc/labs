#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write

// Configuration
const REPO_PATH = Deno.cwd(); // Assumes script is run from repo root

interface PullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: string;
  author: {
    login: string;
  };
}

interface PRReview {
  author: {
    login: string;
  };
  body: string;
  state: string; // APPROVED, CHANGES_REQUESTED, COMMENTED
  submittedAt: string;
  comments?: PRComment[];
}

interface PRComment {
  author: {
    login: string;
  };
  body: string;
  createdAt: string;
  path?: string;
  line?: number;
  diffHunk?: string;
}

interface CheckRun {
  name: string;
  status: string;
  conclusion: string;
  url: string;
}

async function main() {
  try {
    // Get PR number from command line
    const prNumber = Deno.args[0];
    if (!prNumber) {
      console.error('Please provide a PR number');
      Deno.exit(1);
    }

    // Fetch PR details
    console.log(`Fetching PR #${prNumber}...`);
    const prProcess = new Deno.Command("gh", {
      args: ["pr", "view", prNumber, "--json", 
        "number,title,body,url,headRefName,baseRefName,state,isDraft,additions,deletions,changedFiles,mergeable,author"],
    });
    const prOutput = await prProcess.output();
    if (!prOutput.success) {
      console.error("Failed to fetch PR details");
      Deno.exit(1);
    }
    
    const prJSON = new TextDecoder().decode(prOutput.stdout);
    const pr: PullRequest = JSON.parse(prJSON);

    // Fetch PR reviews
    console.log(`Fetching reviews for PR #${prNumber}...`);
    const reviewsProcess = new Deno.Command("gh", {
      args: ["pr", "review", "list", prNumber, "--json", "author,body,state,submittedAt"],
    });
    const reviewsOutput = await reviewsProcess.output();
    let reviews: PRReview[] = [];
    
    if (reviewsOutput.success) {
      const reviewsJSON = new TextDecoder().decode(reviewsOutput.stdout);
      reviews = JSON.parse(reviewsJSON);
    } else {
      console.warn("Warning: Failed to fetch reviews, proceeding without them");
    }

    // Fetch PR comments
    console.log(`Fetching comments for PR #${prNumber}...`);
    const commentsProcess = new Deno.Command("gh", {
      args: ["pr", "comment", "list", prNumber, "--json", "author,body,createdAt,path,line,diffHunk"],
    });
    const commentsOutput = await commentsProcess.output();
    let comments: PRComment[] = [];
    
    if (commentsOutput.success) {
      const commentsJSON = new TextDecoder().decode(commentsOutput.stdout);
      comments = JSON.parse(commentsJSON);
    } else {
      console.warn("Warning: Failed to fetch comments, proceeding without them");
    }

    // Fetch check runs/CI status
    console.log(`Fetching CI status for PR #${prNumber}...`);
    const checksProcess = new Deno.Command("gh", {
      args: ["pr", "checks", prNumber, "--json", "name,status,conclusion,url"],
    });
    const checksOutput = await checksProcess.output();
    let checks: CheckRun[] = [];
    
    if (checksOutput.success) {
      const checksJSON = new TextDecoder().decode(checksOutput.stdout);
      checks = JSON.parse(checksJSON);
    } else {
      console.warn("Warning: Failed to fetch check runs, proceeding without them");
    }

    // Checkout the PR branch
    console.log(`Checking out PR branch: ${pr.headRefName}...`);
    const checkoutProcess = new Deno.Command("gh", {
      args: ["pr", "checkout", prNumber],
    });
    const checkoutOutput = await checkoutProcess.output();
    if (!checkoutOutput.success) {
      console.error("Failed to checkout PR branch");
      Deno.exit(1);
    }

    // Format reviews for the prompt
    const reviewsText = reviews.length > 0
      ? reviews.map(r => `
Review by ${r.author.login} on ${new Date(r.submittedAt).toLocaleString()} - ${r.state}:
${r.body || "[No review text provided]"}
---`).join('\n')
      : "No reviews on this PR.";

    // Format comments for the prompt, prioritizing code-line comments
    const codeComments = comments.filter(c => c.path && c.line);
    const generalComments = comments.filter(c => !c.path || !c.line);
    
    let commentsText = "";
    if (codeComments.length > 0) {
      commentsText += "## Code Line Comments\n";
      commentsText += codeComments.map(c => `
Comment by ${c.author.login} on ${new Date(c.createdAt).toLocaleString()}:
File: ${c.path}, Line: ${c.line}
${c.diffHunk ? `\`\`\`\n${c.diffHunk}\n\`\`\`` : ""}
${c.body}
---`).join('\n');
    }
    
    if (generalComments.length > 0) {
      commentsText += "\n## General Comments\n";
      commentsText += generalComments.map(c => `
Comment by ${c.author.login} on ${new Date(c.createdAt).toLocaleString()}:
${c.body}
---`).join('\n');
    }
    
    if (comments.length === 0) {
      commentsText = "No comments on this PR.";
    }

    // Format check runs/CI status for the prompt
    const checksText = checks.length > 0
      ? checks.map(c => `
${c.name}: ${c.status} - ${c.conclusion || "In progress"}
${c.url}`).join('\n')
      : "No CI checks found for this PR.";

    // Get diff of changes in the PR
    console.log('Getting PR diff...');
    const diffProcess = new Deno.Command("git", {
      args: ["diff", `origin/${pr.baseRefName}...HEAD`],
    });
    const diffOutput = await diffProcess.output();
    let diffText = "Could not retrieve diff.";
    
    if (diffOutput.success) {
      diffText = new TextDecoder().decode(diffOutput.stdout);
    }

    // Prepare comprehensive prompt for Claude
    const fixPrompt = `
I need help addressing feedback on GitHub PR #${pr.number}: "${pr.title}"

## PR Details
URL: ${pr.url}
Branch: ${pr.headRefName} -> ${pr.baseRefName}
State: ${pr.state}${pr.isDraft ? " (Draft)" : ""}
Author: ${pr.author.login}
Changes: +${pr.additions} -${pr.deletions} in ${pr.changedFiles} files
Mergeable: ${pr.mergeable}

## PR Description
${pr.body}

## CI Status / Checks
${checksText}

## Reviews
${reviewsText}

## Comments
${commentsText}

## PR Changes
\`\`\`diff
${diffText.length > 10000 ? diffText.substring(0, 10000) + "\n... [diff truncated due to size]" : diffText}
\`\`\`

Please analyze all of the feedback (reviews, comments, and check failures) and suggest fixes for the issues.
Focus especially on addressing code review comments and fixing CI failures.
Provide specific code changes needed to resolve these issues.
`;

    // Store prompt to a temporary file
    const promptFile = `${REPO_PATH}/.claude-prompt-pr.tmp`;
    await Deno.writeTextFile(promptFile, fixPrompt);
    
    // Invoke Claude Code to fix the issues
    console.log('Invoking Claude Code to analyze feedback and suggest fixes...');
    const claudeProcess = new Deno.Command("claude", {
      args: [fixPrompt],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await claudeProcess.output();
    
    // After fixes are implemented (by the user following Claude's suggestions)
    console.log('\nOnce you have implemented the fixes, press Enter to continue...');
    
    // Read a line from stdin
    const buf = new Uint8Array(1024);
    await Deno.stdin.read(buf);
    
    // Get the git diff to show what changes were made
    console.log('Getting changes for PR comment...');
    const newDiffProcess = new Deno.Command("git", {
      args: ["diff", "--staged"],
    });
    const newDiffOutput = await newDiffProcess.output();
    let newDiffText = "No changes detected.";
    
    if (newDiffOutput.success) {
      newDiffText = new TextDecoder().decode(newDiffOutput.stdout);
    }
    
    // Ask Claude to summarize the fixes for the PR comment
    console.log('Asking Claude to summarize fixes for PR comment...');
    const summaryPrompt = `
I've just addressed feedback on GitHub PR #${pr.number}: "${pr.title}"

Here are the changes I made (git diff):
\`\`\`
${newDiffText}
\`\`\`

Please provide a concise summary of these changes for a PR comment.
Explain how these changes address the feedback and review comments.
Keep it professional and technical. Focus on what was fixed and how it addresses the concerns raised.
`;

    // Run Claude to summarize the changes
    const summaryProcess = new Deno.Command("claude", {
      args: ["--print", summaryPrompt],
    });
    const summaryOutput = await summaryProcess.output();
    let fixSummary = "Implemented fixes based on feedback.";
    
    if (summaryOutput.success) {
      fixSummary = new TextDecoder().decode(summaryOutput.stdout);
    } else {
      console.warn("Warning: Failed to generate fix summary, using default");
    }
    
    // Commit the changes
    console.log('Committing changes...');
    const commitMessage = `Address feedback on PR #${pr.number}`;
    await new Deno.Command("git", { args: ["add", "."] }).output();
    await new Deno.Command("git", { args: ["commit", "-m", commitMessage] }).output();
    
    // Push the changes
    console.log('Pushing changes...');
    const pushProcess = new Deno.Command("git", {
      args: ["push", "origin", pr.headRefName],
    });
    const pushOutput = await pushProcess.output();
    if (!pushOutput.success) {
      console.error("Failed to push changes");
      Deno.exit(1);
    }
    
    // Add comment to the PR
    console.log('Adding comment to PR...');
    const commentFile = `${REPO_PATH}/.pr-comment.tmp`;
    await Deno.writeTextFile(commentFile, fixSummary);
    
    const commentProcess = new Deno.Command("gh", {
      args: ["pr", "comment", prNumber, "--body-file", commentFile],
    });
    const commentOutput = await commentProcess.output();
    if (!commentOutput.success) {
      console.error("Failed to add comment to PR");
    }
    
    // Clean up temporary files
    try {
      await Deno.remove(promptFile);
      await Deno.remove(commentFile);
    } catch (error) {
      console.error('Error cleaning up temporary files:', error);
    }
    
    console.log('Done! PR fixes implemented and comment added.');
    
  } catch (error) {
    console.error('Error:', error);
    Deno.exit(1);
  }
}

main();