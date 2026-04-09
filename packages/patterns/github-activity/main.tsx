import {
  computed,
  Default,
  derive,
  fetchData,
  generateText,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

type CommitResponse = Array<{
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: {
      name: string;
      date: string;
    };
  };
}>;

function parseUrl(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return { owner: "", repo: "" };
}

export default pattern<{
  repoUrl: Writable<
    Default<string, "https://github.com/anthropics/claude-code">
  >;
}>((state) => {
  // Parse URL and create API endpoint
  const parsed = computed(() => parseUrl(state.repoUrl.get()));
  const apiUrl = computed(() => {
    const { owner, repo } = parsed;
    if (owner && repo) {
      return `https://api.github.com/repos/${owner}/${repo}/commits`;
    }
    return "";
  });

  // Fetch commits data
  const commitsData = fetchData<CommitResponse>({
    url: apiUrl,
    mode: "json",
  });
  const commits = commitsData.result;

  // Build prompt from commits
  const prompt = computed(() => {
    const commitList = commits ?? [];
    if (commitList.length === 0) return "";

    const messages = commitList
      .slice(0, 10)
      .map((c) => `- ${c.commit.message.split("\n")[0]}`)
      .join("\n");

    return `Recent commits:\n${messages}`;
  });

  // Generate summary
  const summary = generateText({
    system:
      "You are a concise technical writer. Summarize the recent development activity based on these commit messages. Focus on themes and notable changes. Keep it to 2-3 sentences.",
    prompt: prompt,
  });

  const repoName = computed(() => {
    const { owner, repo } = parsed;
    if (owner && repo) {
      return `${owner}/${repo}`;
    }
    return "GitHub Activity";
  });

  return {
    [NAME]: computed(() => `GitHub Activity: ${repoName}`),
    [UI]: (
      <div>
        <div style="margin-bottom: 16px;">
          <cf-input
            $value={state.repoUrl}
            placeholder="https://github.com/owner/repo"
            customStyle="width: 100%; padding: 8px; font-size: 14px;"
          />
        </div>

        <cf-cell-context $cell={summary.pending}>
          {derive(
            [summary.pending, summary.result],
            ([pending, result]) =>
              pending
                ? (
                  <div style="margin-bottom: 16px;">
                    <cf-loader show-elapsed /> Generating summary...
                  </div>
                )
                : result
                ? (
                  <div style="margin-bottom: 16px; padding: 12px; background: #f5f5f5; border-radius: 4px;">
                    <h3 style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600;">
                      Activity Summary
                    </h3>
                    <p style="margin: 0; line-height: 1.5;">{result}</p>
                  </div>
                )
                : null,
          )}
        </cf-cell-context>

        <cf-cell-context $cell={commits}>
          {derive(commits, (commitList) => {
            if (!commitList || commitList.length === 0) {
              return (
                <div style="padding: 16px; text-align: center; color: #666;">
                  No commits found
                </div>
              );
            }

            return (
              <div style="max-height: 500px; overflow-y: auto;">
                {commitList.slice(0, 20).map((commit) => {
                  const firstLine = commit.commit.message.split("\n")[0];
                  const date = new Date(commit.commit.author.date)
                    .toLocaleDateString();

                  return (
                    <cf-card style="margin-bottom: 8px;">
                      <div style="padding: 12px;">
                        <div style="font-weight: 500; margin-bottom: 4px;">
                          {firstLine}
                        </div>
                        <div style="font-size: 13px; color: #666; margin-bottom: 8px;">
                          {commit.commit.author.name} • {date}
                        </div>
                        <a
                          href={commit.html_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style="font-size: 13px; color: #0969da;"
                        >
                          View commit →
                        </a>
                      </div>
                    </cf-card>
                  );
                })}
              </div>
            );
          })}
        </cf-cell-context>
      </div>
    ),
  };
});
