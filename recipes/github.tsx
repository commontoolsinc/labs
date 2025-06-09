import { h } from "@commontools/html";
import {
  cell,
  derive,
  handler,
  JSONSchema,
  NAME,
  recipe,
  str,
  UI,
} from "@commontools/builder/interface";
import { sleep } from "@commontools/utils/sleep";

interface GitHubCommit {
  sha: string;
  commit: {
    author: {
      name: string;
      date: string;
    };
    message: string;
  };
  html_url: string;
  stats?: {
    additions: number;
    deletions: number;
    total: number;
  };
  files?: Array<{
    filename: string;
    patch?: string;
  }>;
}

async function getCommitDetails(
  owner: string,
  repo: string,
  sha: string,
): Promise<GitHubCommit> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`;

  const response = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "Deno/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.statusText}`);
  }

  return await response.json();
}

async function getRecentCommits(
  owner: string,
  repo: string,
  perPage = 10,
): Promise<GitHubCommit[]> {
  const url =
    `https://api.github.com/repos/${owner}/${repo}/commits?per_page=${perPage}`;

  const response = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "Deno/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.statusText}`);
  }

  const commits = await response.json();

  await sleep(1000);

  const detailedCommits: GitHubCommit[] = [];
  for (const commit of commits) {
    const detailedCommit = await getCommitDetails(owner, repo, commit.sha);
    console.log(detailedCommit);
    detailedCommits.push(detailedCommit);
    await sleep(1000);
  }

  return detailedCommits;
}

const recipeSchema = {
  type: "object",
  properties: {
    owner: { type: "string", default: "commontoolsinc" },
    repo: { type: "string", default: "labs" },
  },
  title: "GitHub Commits",
  description: "Fetch commits from the specified GitHub repository.",
} as const satisfies JSONSchema;

const CommitSchema = {
  type: "object",
  properties: {
    sha: { type: "string" },
    commit: {
      type: "object",
      properties: {
        author: {
          type: "object",
          properties: {
            name: { type: "string" },
            date: { type: "string" },
          },
        },
        message: { type: "string" },
      },
    },
    html_url: { type: "string" },
    stats: {
      type: "object",
      properties: {
        additions: { type: "number" },
        deletions: { type: "number" },
        total: { type: "number" },
      },
    },
  },
} as const satisfies JSONSchema;

const outputSchema = {
  type: "object",
  properties: {
    commits: {
      type: "array",
      items: CommitSchema,
    },
    updater: {
      asStream: true,
      type: "object",
      properties: {},
    },
  },
} as const satisfies JSONSchema;

const refreshCommits = handler({}, {
  type: "object",
  properties: {
    commits: { type: "array", items: CommitSchema },
    repo: { type: "string" },
    owner: { type: "string" },
  },
  required: ["commits", "repo", "owner"],
}, async (_, state) => {
  console.log("refreshing commits", JSON.stringify(state, null, 2));
  const commits = await getRecentCommits(state.owner, state.repo);
  commits.forEach((commit) => {
    console.log(commit);
  });
  // state.commits.update(() => commits);
});

export default recipe(recipeSchema, outputSchema, ({ repo, owner }) => {
  const commits = cell<GitHubCommit[]>([]);

  return {
    [NAME]: str`GitHub Commits: ${repo}/${owner}`,
    [UI]: (
      <div
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          padding: "20px",
        }}
      >
        <button
          type="button"
          onClick={refreshCommits({ commits, repo, owner })}
          style={{
            padding: "8px 16px",
            backgroundColor: "#2ea44f",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
            marginBottom: "20px",
          }}
        >
          Refresh Commits
        </button>
        <pre>
          {derive(commits, (commits) => JSON.stringify(commits, null, 2))}
        </pre>
      </div>
    ),
    updater: refreshCommits({ commits, repo, owner }),
    commits,
  };
});
