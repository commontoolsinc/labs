#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write

// Configuration
const REPO_PATH = Deno.cwd(); // Assumes script is run from repo root

interface PRComment {
  author: string;
  body: string;
  createdAt?: string;
  path?: string;
  line?: number;
  diffHunk?: string;
}

/**
 * Find the git repository root directory
 */
async function findRepoRoot(startPath: string): Promise<string> {
  try {
    const gitDirProcess = new Deno.Command("git", {
      args: ["-C", startPath, "rev-parse", "--show-toplevel"],
    });
    const gitDirOutput = await gitDirProcess.output();

    if (gitDirOutput.success) {
      return new TextDecoder().decode(gitDirOutput.stdout).trim();
    } else {
      throw new Error("Not a git repository");
    }
  } catch (error) {
    console.error("Error finding git repository root:", error);
    throw error;
  }
}

async function main() {
  try {
    // Get to the repository root first
    const repoRoot = await findRepoRoot(Deno.cwd());
    console.log(`Found repository root: ${repoRoot}`);
    Deno.chdir(repoRoot);

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

    // Get PR view with comments and details
    console.log(`Fetching PR #${prNumber} details...`);
    const viewProcess = new Deno.Command("gh", {
      args: [
        "pr",
        "view",
        prNumber,
        "--json",
        "body,comments,state,statusCheckRollup,changedFiles",
      ],
    });
    const viewOutput = await viewProcess.output();
    if (!viewOutput.success) {
      console.error("Failed to fetch PR view");
      Deno.exit(1);
    }

    const prView = new TextDecoder().decode(viewOutput.stdout);
    console.log("PR View Output:", prView);

    // Create a temporary file for the prompt
    const promptFileName = ".claude-prompt-pr.tmp";
    const prompt = `
I need help analyzing a pull request and implementing any necessary changes.

Here's the full PR information:

${prView}

Please review the PR details above and decide if any changes are needed.
If changes are needed, please provide the exact code changes to implement.
If no changes are needed, please explain why.
`;

    // Write the prompt to a temporary file
    await Deno.writeTextFile(promptFileName, prompt);

    // Invoke Claude Code
    console.log(
      "Asking Claude to analyze the PR and suggest changes if needed...",
    );
    const claudeProcess = new Deno.Command("claude", {
      args: [promptFileName],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await claudeProcess.output();

    // After Claude has provided feedback
    console.log(
      "\nIf you want to apply any changes, press Enter to commit and push...",
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
    const commitMessage = `Apply changes from PR #${prNumber} review`;
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
