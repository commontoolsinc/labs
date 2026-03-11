/// <cts-enable />
/**
 * CT-1341 minimal repro: fetchData inside sub-pattern with chained fetches
 * triggered by pushing items via action.
 *
 * Steps to reproduce:
 *   1. Deploy and open in browser
 *   2. Click "Add Repo" button
 *   3. Check browser DevTools console for "Invalid fact.value with no value"
 *
 * This mimics the star tracker's structure: an action pushes to an array,
 * .map() creates sub-patterns, each sub-pattern has multiple fetchData calls
 * with chained computed URLs (fetch2 depends on fetch1 completing).
 */
import { action, computed, Default, fetchData, FetchOptions, pattern, Stream, Writable, NAME, UI, type VNode } from "commontools";

// ===== Sub-pattern: fetches repo info then stargazers =====

interface RepoInput {
  owner: string;
  repo: string;
}

interface RepoOutput {
  [NAME]: string;
  [UI]: VNode;
  owner: string;
  repo: string;
  stars: number;
  status: string;
}

const RepoCard = pattern<RepoInput, RepoOutput>(({ owner, repo }) => {
  const repoApiUrl = computed(
    () => `https://api.github.com/repos/${owner}/${repo}`,
  );

  // First fetch: repo info
  const repoInfo = fetchData<any>({
    url: repoApiUrl,
    mode: "json",
  });

  // Chained fetch: stargazers (only after repo info loads)
  const stargazersUrl = computed(() => {
    if (!(repoInfo.result || repoInfo.error)) return "";
    return `https://api.github.com/repos/${owner}/${repo}/stargazers?per_page=5`;
  });

  const stargazers = fetchData<any>({
    url: stargazersUrl,
    mode: "json",
    options: { headers: { Accept: "application/vnd.github.star+json" } },
  });

  // Third chained fetch
  const readmeUrl = computed(() => {
    if (!(stargazers.result || stargazers.error)) return "";
    return `https://api.github.com/repos/${owner}/${repo}/readme`;
  });

  const readme = fetchData<any>({
    url: readmeUrl,
    mode: "json",
  });

  const stars = computed(
    () => (repoInfo.result as any)?.stargazers_count ?? 0,
  );

  const status = computed(() => {
    if (repoInfo.error) return "error: " + JSON.stringify(repoInfo.error);
    if (!repoInfo.result) return "loading repo info...";
    if (!stargazers.result && !stargazers.error) return "loading stargazers...";
    if (!readme.result && !readme.error) return "loading readme...";
    return "done";
  });

  return {
    [NAME]: computed(() => `${owner}/${repo}`),
    [UI]: (
      <ct-card>
        <ct-vstack gap="1">
          <ct-heading level={6}>
            {owner}/{repo}
          </ct-heading>
          <span>Stars: {stars}</span>
          <span>Status: {status}</span>
        </ct-vstack>
      </ct-card>
    ),
    owner,
    repo,
    stars,
    status,
  };
});

// ===== Main pattern =====

interface RepoEntry {
  owner: string;
  repo: string;
}

interface AppInput {
  repos?: Writable<Default<RepoEntry[], []>>;
}

interface AppOutput {
  [NAME]: string;
  [UI]: VNode;
  repos: RepoEntry[];
  addRepo: Stream<void>;
}

export default pattern<AppInput, AppOutput>(({ repos }) => {
  const addRepo = action(() => {
    repos.push({ owner: "anthropics", repo: "anthropic-sdk-python" });
    repos.push({ owner: "facebook", repo: "react" });
    repos.push({ owner: "denoland", repo: "deno" });
  });

  const cards = repos.map((entry: RepoEntry) => (
    <RepoCard owner={entry.owner} repo={entry.repo} />
  ));

  return {
    [NAME]: "CT-1341 Repro",
    repos,
    addRepo,
    [UI]: (
      <ct-vstack gap="3" style="padding: 1rem;">
        <ct-heading level={4}>CT-1341 Repro</ct-heading>
        <p>1. Click "Add Repos"</p>
        <p>2. Check DevTools console for "Invalid fact.value with no value"</p>
        <ct-button variant="primary" onClick={() => addRepo.send()}>
          Add Repos
        </ct-button>
        <p>Repos: {computed(() => repos.get().length)}</p>
        {cards}
      </ct-vstack>
    ),
  };
});
