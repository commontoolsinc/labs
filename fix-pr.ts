#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write

// Configuration
const REPO_PATH = Deno.cwd(); // Assumes script is run from repo root

interface PRComment {
  author: {
    login: string;
  };
  body: string;
  createdAt: string;
  path?: string;
  line?: number;
  diffHunk?: string;
  isResolved?: boolean;
}

interface PRReview {
  author: {
    login: string;
  };
  body: string;
  state: string;
  submittedAt: string;
  comments?: PRComment[];
}

async function main() {
  try {
    // Get PR number from command line
    const prNumber = Deno.args[0];
    if (!prNumber) {
      console.error("Please provide a PR number");
      Deno.exit(1);
    }

    // Fetch PR branch info
    console.log(`Fetching PR #${prNumber} branch info...`);
    const prProcess = new Deno.Command("gh", {
      args: ["pr", "view", prNumber, "--json", "headRefName"],
    });
    const prOutput = await prProcess.output();
    if (!prOutput.success) {
      console.error("Failed to fetch PR details");
      Deno.exit(1);
    }

    const prJSON = new TextDecoder().decode(prOutput.stdout);
    const pr = JSON.parse(prJSON);

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

    // Try multiple approaches to get comments
    let reviewComments: PRComment[] = [];

    // Approach 1: Try to get review comments (inline comments)
    console.log(`Fetching review comments for PR #${prNumber}...`);
    const reviewCommentsProcess = new Deno.Command("gh", {
      args: [
        "api",
        `repos/:owner/:repo/pulls/${prNumber}/comments`,
        "--jq",
        ".[]",
      ],
    });
    const reviewCommentsOutput = await reviewCommentsProcess.output();

    if (reviewCommentsOutput.success) {
      try {
        const commentsText = new TextDecoder().decode(
          reviewCommentsOutput.stdout,
        );
        if (commentsText.trim()) {
          const comments = JSON.parse(
            `[${
              commentsText.replace(/\n}\n{/g, "},{").replace(/\}\s*\{/g, "},{")
            }]`,
          );
          reviewComments = comments.map((c: any) => ({
            author: { login: c.user?.login || "Unknown" },
            body: c.body || "",
            createdAt: c.created_at || "",
            path: c.path,
            line: c.line || c.position,
            diffHunk: c.diff_hunk,
            isResolved: c.resolved || false,
          }));
        }
      } catch (e) {
        console.warn("Warning: Error parsing review comments", e);
      }
    }

    // Approach 2: Try to get reviews with their comments
    console.log(`Fetching reviews for PR #${prNumber}...`);
    const reviewsProcess = new Deno.Command("gh", {
      args: [
        "pr",
        "review",
        "list",
        prNumber,
        "--json",
        "author,body,state,submittedAt",
      ],
    });
    const reviewsOutput = await reviewsProcess.output();

    if (reviewsOutput.success) {
      try {
        const reviewsJSON = new TextDecoder().decode(reviewsOutput.stdout);
        const reviews: PRReview[] = JSON.parse(reviewsJSON);

        // Add review bodies as comments if they contain feedback
        for (const review of reviews) {
          if (
            review.body && (
              review.body.includes("```") ||
              review.body.toLowerCase().includes("suggestion") ||
              review.state === "CHANGES_REQUESTED"
            )
          ) {
            reviewComments.push({
              author: review.author,
              body: `${review.state} review: ${review.body}`,
              createdAt: review.submittedAt,
              isResolved: false,
            });
          }
        }
      } catch (e) {
        console.warn("Warning: Error parsing reviews", e);
      }
    }

    // Approach 3: Try to get general PR comments
    console.log(`Fetching general comments for PR #${prNumber}...`);
    const generalCommentsProcess = new Deno.Command("gh", {
      args: [
        "api",
        `repos/:owner/:repo/issues/${prNumber}/comments`,
        "--jq",
        ".[]",
      ],
    });
    const generalCommentsOutput = await generalCommentsProcess.output();

    if (generalCommentsOutput.success) {
      try {
        const commentsText = new TextDecoder().decode(
          generalCommentsOutput.stdout,
        );
        if (commentsText.trim()) {
          const comments = JSON.parse(
            `[${
              commentsText.replace(/\n}\n{/g, "},{").replace(/\}\s*\{/g, "},{")
            }]`,
          );
          const generalComments = comments.map((c: any) => ({
            author: { login: c.user?.login || "Unknown" },
            body: c.body || "",
            createdAt: c.created_at || "",
            isResolved: false,
          })).filter((c: PRComment) =>
            c.body.includes("```") ||
            c.body.toLowerCase().includes("suggestion")
          );

          reviewComments = [...reviewComments, ...generalComments];
        }
      } catch (e) {
        console.warn("Warning: Error parsing general comments", e);
      }
    }

    // Filter out resolved comments
    const unresolvedComments = reviewComments.filter((comment) =>
      !comment.isResolved
    );

    if (unresolvedComments.length === 0) {
      console.log("No unresolved review comments with suggestions found.");
      Deno.exit(0);
    }

    console.log(
      `Found ${unresolvedComments.length} unresolved review comments with potential suggestions.`,
    );

    // Format comments for Claude prompt
    const commentsText = unresolvedComments.map((c) => {
      let commentText = `Comment by ${c.author.login} on ${
        new Date(c.createdAt).toLocaleString()
      }:\n`;

      if (c.path && c.line) {
        commentText += `File: ${c.path}, Line: ${c.line}\n`;
      }

      if (c.diffHunk) {
        commentText += `\`\`\`\n${c.diffHunk}\n\`\`\`\n`;
      }

      commentText += `${c.body}\n---\n`;
      return commentText;
    }).join("\n");

    // Create a temporary file for the prompt
    const promptFileName = ".claude-prompt-pr.tmp";
    const prompt = `
I need help applying fixes suggested in code review comments for PR #${prNumber}.
Here are the review comments with suggestions:

${commentsText}

Please provide the exact code changes needed to address these review comments.
Focus only on implementing the specific suggestions mentioned in the comments.
`;

    // Write the prompt to a temporary file
    await Deno.writeTextFile(promptFileName, prompt);

    // Invoke Claude Code to implement the fixes
    console.log("Asking Claude Code to apply the suggested fixes...");
    const claudeProcess = new Deno.Command("claude", {
      args: [promptFileName],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await claudeProcess.output();

    // After fixes are implemented
    console.log(
      "\nOnce you have implemented the fixes, press Enter to commit and push...",
    );

    // Read a line from stdin
    const buf = new Uint8Array(1024);
    await Deno.stdin.read(buf);

    // Remove temporary prompt file
    try {
      await Deno.remove(promptFileName);
    } catch (e) {
      console.warn(
        `Warning: Could not remove temporary file ${promptFileName}`,
        e,
      );
    }

    // Commit the changes
    console.log("Committing changes...");
    const commitMessage = `Apply review suggestions from PR #${prNumber}`;
    await new Deno.Command("git", { args: ["add", "."] }).output();
    await new Deno.Command("git", { args: ["commit", "-m", commitMessage] })
      .output();

    // Push the changes
    console.log("Pushing changes...");
    const pushProcess = new Deno.Command("git", {
      args: ["push", "origin", pr.headRefName],
    });
    const pushOutput = await pushProcess.output();
    if (!pushOutput.success) {
      console.error("Failed to push changes");
      Deno.exit(1);
    }

    console.log("Done! Changes pushed to PR branch.");
  } catch (error) {
    console.error("Error:", error);
    Deno.exit(1);
  }
}

main();
