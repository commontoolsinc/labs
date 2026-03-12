/// <cts-enable />
/**
 * Strip test 4: Same as strip3 but replaces simple growth series with
 * stargazerPages computed + buildGrowthSeries (reading actual timestamps).
 * Testing if this collection computed breaks rendering.
 */
import {
  action,
  computed,
  Default,
  fetchData,
  FetchOptions,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";

// ===== Helpers =====

function formatStars(n: number): string {
  if (n >= 10000) return Math.round(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function classificationColor(c: string | null): string {
  if (c === "accelerating") return "#22c55e";
  if (c === "linear") return "#60a5fa";
  if (c === "decelerating") return "#f59e0b";
  return "#9ca3af";
}

function sparklineColor(c: string | null): string {
  if (c === "accelerating") return "#22c55e";
  if (c === "linear") return "#60a5fa";
  if (c === "decelerating") return "#f59e0b";
  return "#9ca3af";
}

// ===== Repo Parsing =====

interface ParsedRepo {
  owner: string;
  repo: string;
  key: string;
}

function parseRepoInput(input: string): ParsedRepo[] {
  const results: ParsedRepo[] = [];
  const lines = input.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    const bareMatch = line.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
    if (bareMatch) {
      results.push({ owner: bareMatch[1], repo: bareMatch[2], key: `${bareMatch[1]}/${bareMatch[2]}`.toLowerCase() });
    }
  }
  return results;
}

// ===== Growth Series =====

interface StarDataPoint { x: number; y: number; }
interface StargazerEntry { starred_at: string; }

function buildGrowthSeries(
  stargazerPages: (StargazerEntry[] | null)[],
  totalStars: number,
  createdAt: string | null,
): StarDataPoint[] {
  const timestamps: number[] = [];
  for (const page of stargazerPages) {
    if (!page) continue;
    for (const entry of page) {
      if (entry.starred_at) timestamps.push(new Date(entry.starred_at).getTime());
    }
  }
  if (timestamps.length === 0) {
    const now = Date.now();
    if (!createdAt) return [{ x: now - 30 * 86400000, y: 0 }, { x: now, y: Math.max(0, totalStars) }];
    const created = new Date(createdAt).getTime();
    const points: StarDataPoint[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = created + (i / 10) * (now - created);
      points.push({ x: t, y: Math.round(totalStars * Math.sqrt(i / 10)) });
    }
    return points;
  }
  timestamps.sort((a, b) => a - b);
  const scaleFactor = totalStars > 0 ? totalStars / timestamps.length : 1;
  return timestamps.map((ts, i) => ({ x: ts, y: Math.round((i + 1) * scaleFactor) }));
}

function classifyGrowth(series: StarDataPoint[]): "accelerating" | "linear" | "decelerating" | null {
  if (series.length < 4) return null;
  const mid = Math.floor(series.length / 2);
  const firstHalfStars = series[mid].y - series[0].y;
  const firstHalfTime = series[mid].x - series[0].x;
  const secondHalfStars = series[series.length - 1].y - series[mid].y;
  const secondHalfTime = series[series.length - 1].x - series[mid].x;
  if (firstHalfTime === 0 || secondHalfTime === 0) return "linear";
  const ratio = (secondHalfStars / secondHalfTime) / (firstHalfStars / firstHalfTime);
  if (ratio > 1.25) return "accelerating";
  if (ratio < 0.75) return "decelerating";
  return "linear";
}

function stargazerHeaders(token: string): FetchOptions {
  const opts: FetchOptions = {};
  if (token.trim()) {
    opts.headers = { Accept: "application/vnd.github.star+json", Authorization: `Bearer ${token.trim()}` };
  } else {
    opts.headers = { Accept: "application/vnd.github.star+json" };
  }
  return opts;
}

function repoInfoOpts(token: string): FetchOptions {
  if (token.trim()) return { headers: { Authorization: `Bearer ${token.trim()}` } };
  return {};
}

function starPageUrl(owner: string, repo: string, page: number): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/stargazers?per_page=100&page=${page}`;
}

function samplePages(totalStars: number): number[] {
  if (totalStars === 0) return [1];
  const lastPage = Math.ceil(totalStars / 100);
  if (lastPage <= 5) return Array.from({ length: Math.min(lastPage, 5) }, (_, i) => i + 1);
  return [1, Math.max(1, Math.round(lastPage / 4)), Math.max(1, Math.round(lastPage / 2)), Math.max(1, Math.round((3 * lastPage) / 4)), lastPage];
}

// ===== Repo Entry =====
interface RepoEntry { owner: string; repoName: string; key: string; }

// ===== RepoCard Sub-Pattern — FLAT PROPS (matching debug pattern) =====

interface RepoCardInput {
  owner: string;
  repoName: string;
  cardKey: string;
  githubToken: string;
  onRemove: Stream<{ key: string }>;
}

interface RepoCardOutput {
  [NAME]: string;
  [UI]: VNode;
  key: string;
  repoName: string;
  owner: string;
  starCount: number;
  growthClassification: string | null;
  growthSeries: StarDataPoint[];
  isLoading: boolean;
  hasError: boolean;
  errorMsg: string;
  description: string | null;
  language: string | null;
  createdAt: string | null;
  forkCount: number;
}

const RepoCard = pattern<RepoCardInput, RepoCardOutput>(
  ({ owner, repoName, cardKey, githubToken, onRemove }) => {
    const key = cardKey;
    const repoApiUrl = computed(() => `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`);

    const repoInfoFetch = fetchData<any>({
      url: repoApiUrl,
      mode: "json",
      options: computed(() => repoInfoOpts(githubToken)),
    });

    const repoInfoDone = computed(() => !!(repoInfoFetch.result || repoInfoFetch.error));

    const starCount = computed(() => (repoInfoFetch.result as any)?.stargazers_count ?? 0);
    const description = computed(() => (repoInfoFetch.result as any)?.description ?? null);
    const language = computed(() => (repoInfoFetch.result as any)?.language ?? null);
    const createdAt = computed(() => (repoInfoFetch.result as any)?.created_at ?? null);
    const forkCount = computed(() => (repoInfoFetch.result as any)?.forks_count ?? 0);

    // Dynamic pages via samplePages (testing if this breaks rendering)
    const sgHeaders = computed(() => stargazerHeaders(githubToken));

    const pagesToFetch = computed(() => {
      if (!repoInfoDone) return [] as number[];
      return samplePages(starCount);
    });

    const page0Url = computed(() =>
      repoInfoDone && pagesToFetch.length > 0 ? starPageUrl(owner, repoName, pagesToFetch[0]) : ""
    );
    const page0 = fetchData<StargazerEntry[]>({ url: page0Url, mode: "json", options: sgHeaders });

    const page1Url = computed(() => {
      if (!(page0.result || page0.error)) return "";
      if (pagesToFetch.length < 2) return "";
      return starPageUrl(owner, repoName, pagesToFetch[1]);
    });
    const page1 = fetchData<StargazerEntry[]>({ url: page1Url, mode: "json", options: sgHeaders });

    const page2Url = computed(() => {
      if (!(page1.result || page1.error)) return "";
      if (pagesToFetch.length < 3) return "";
      return starPageUrl(owner, repoName, pagesToFetch[2]);
    });
    const page2 = fetchData<StargazerEntry[]>({ url: page2Url, mode: "json", options: sgHeaders });

    const page3Url = computed(() => {
      if (!(page2.result || page2.error)) return "";
      if (pagesToFetch.length < 4) return "";
      return starPageUrl(owner, repoName, pagesToFetch[3]);
    });
    const page3 = fetchData<StargazerEntry[]>({ url: page3Url, mode: "json", options: sgHeaders });

    const page4Url = computed(() => {
      if (!(page3.result || page3.error)) return "";
      if (pagesToFetch.length < 5) return "";
      return starPageUrl(owner, repoName, pagesToFetch[4]);
    });
    const page4 = fetchData<StargazerEntry[]>({ url: page4Url, mode: "json", options: sgHeaders });

    // Collect stargazer pages (THIS IS THE SUSPECT)
    const stargazerPages = computed(() => {
      const pages: (StargazerEntry[] | null)[] = [];
      if (page0Url && (page0.result || page0.error)) pages.push((page0.result as StargazerEntry[] | null) ?? null);
      if (page1Url && (page1.result || page1.error)) pages.push((page1.result as StargazerEntry[] | null) ?? null);
      if (page2Url && (page2.result || page2.error)) pages.push((page2.result as StargazerEntry[] | null) ?? null);
      if (page3Url && (page3.result || page3.error)) pages.push((page3.result as StargazerEntry[] | null) ?? null);
      if (page4Url && (page4.result || page4.error)) pages.push((page4.result as StargazerEntry[] | null) ?? null);
      return pages;
    });

    const growthSeries = computed(() => buildGrowthSeries(stargazerPages, starCount, createdAt));
    const growthClassification = computed(() => classifyGrowth(growthSeries));

    const errorMsg = computed(() => {
      if (repoInfoFetch.error) return String(repoInfoFetch.error);
      if (page0.error) return String(page0.error);
      return "";
    });
    const hasError = computed(() => !!errorMsg);
    const isLoading = computed(() => !!(repoInfoFetch.pending || (!repoInfoFetch.result && !repoInfoFetch.error)));

    return {
      [NAME]: computed(() => `${owner}/${repoName}`),
      [UI]: (
        <ct-card style="border-left: 3px solid #ccc; min-height: 160px;">
          <ct-vstack gap="2">
            <ct-hstack justify="between" align="start">
              <ct-vstack gap="0">
                <ct-heading level={6} style="font-size: 0.9rem; margin: 0;">
                  {repoName}
                </ct-heading>
                <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                  {owner}
                </span>
              </ct-vstack>
              <ct-button variant="ghost" size="sm" onClick={() => onRemove.send({ key })}>
                ×
              </ct-button>
            </ct-hstack>

            {isLoading
              ? (
                <ct-vstack gap="2">
                  <div style={{ height: "1rem", width: "40%", backgroundColor: "#f3f4f6", borderRadius: "0.25rem" }} />
                  <div style={{ height: "48px", backgroundColor: "#f3f4f6", borderRadius: "0.25rem" }} />
                </ct-vstack>
              )
              : hasError
              ? (
                <ct-vstack gap="1" style="padding: 0.5rem 0;">
                  <span style={{ fontSize: "0.8rem", color: "#dc2626", fontWeight: "500" }}>Error</span>
                  <span style={{ fontSize: "0.75rem", color: "#dc2626" }}>{errorMsg}</span>
                </ct-vstack>
              )
              : (
                <ct-vstack gap="2">
                  <ct-hstack gap="3" align="center">
                    <ct-hstack gap="1" align="center">
                      <span style={{ fontSize: "1rem" }}>★</span>
                      <span style={{ fontWeight: "600", fontSize: "0.95rem" }}>
                        {computed(() => formatStars(starCount))}
                      </span>
                    </ct-hstack>
                    {language
                      ? (
                        <span style={{ fontSize: "0.75rem", color: "#6b7280", backgroundColor: "#f3f4f6", padding: "0.125rem 0.5rem", borderRadius: "9999px" }}>
                          {language}
                        </span>
                      )
                      : null}
                  </ct-hstack>

                  {growthSeries.length > 0
                    ? (
                      <div style={{ height: "48px" }}>
                        <ct-chart height={48} style="width: 100%;">
                          <ct-line-mark
                            $data={growthSeries}
                            x="x"
                            y="y"
                            color={computed(() => sparklineColor(growthClassification))}
                            strokeWidth={2}
                            curve="monotone"
                          />
                        </ct-chart>
                      </div>
                    )
                    : (
                      <div style={{ height: "48px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span style={{ fontSize: "0.7rem", color: "#9ca3af" }}>Loading sparkline...</span>
                      </div>
                    )}

                  {growthClassification
                    ? (
                      <span style={{ fontSize: "0.7rem", fontWeight: "600", padding: "0.125rem 0.5rem", borderRadius: "9999px", backgroundColor: "#f3f4f6", color: "#6b7280" }}>
                        {growthClassification}
                      </span>
                    )
                    : null}
                </ct-vstack>
              )}
          </ct-vstack>
        </ct-card>
      ),
      key,
      repoName,
      owner,
      starCount,
      growthClassification,
      growthSeries,
      isLoading,
      hasError,
      errorMsg,
      description,
      language,
      createdAt,
      forkCount,
    };
  }
);

// ===== Main Pattern =====

interface StarTrackerInput {
  repos?: Writable<Default<RepoEntry[], []>>;
  githubToken?: Writable<Default<string, "">>;
}

export default pattern<StarTrackerInput, any>(
  ({ repos, githubToken }) => {
    const removeRepo = action(({ key }: { key: string }) => {
      repos.set(repos.get().filter((r) => r.key !== key));
    });

    const addRepos = action(({ input }: { input: string }) => {
      if (!input.trim()) return;
      const parsed = parseRepoInput(input);
      const currentKeys = new Set(repos.get().map((r) => r.key));
      for (const p of parsed) {
        if (!currentKeys.has(p.key)) {
          repos.push({ owner: p.owner, repoName: p.repo, key: p.key });
          currentKeys.add(p.key);
        }
      }
    });

    // Direct .map() on repos — no visibleRepos computed slice
    const repoCards = repos.map((entry: RepoEntry) => (
      <RepoCard
        owner={entry.owner}
        repoName={entry.repoName}
        cardKey={entry.key}
        githubToken={githubToken}
        onRemove={removeRepo}
      />
    ));

    // Sort cards
    const sortedCards = computed(() => {
      const cards = repoCards as any[];
      const sorted = [...cards];
      sorted.sort((a, b) => {
        if (a.isLoading && !b.isLoading) return 1;
        if (!a.isLoading && b.isLoading) return -1;
        return (b.starCount ?? 0) - (a.starCount ?? 0);
      });
      return sorted;
    });

    const repoCount = computed(() => repos.get().length);

    return {
      [NAME]: computed(() => `Star Tracker Strip4 (${repoCount})`),
      repos,
      githubToken,
      addRepos,
      removeRepo,
      [UI]: (
        <ct-vstack gap="3" style="padding: 1rem;">
          <ct-heading level={4}>Star Tracker (Strip Test 4 — stargazerPages + buildGrowthSeries)</ct-heading>
          <ct-hstack gap="2" align="center">
            <span>Token:</span>
            <ct-input $value={githubToken} placeholder="ghp_..." style="width: 300px; font-family: monospace;" />
          </ct-hstack>
          <ct-button
            variant="primary"
            onClick={() => addRepos.send({ input: "commontoolsinc/labs\ndenoland/deno" })}
          >
            Add Repos
          </ct-button>
          <p>Repos: {repoCount}</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "0.75rem" }}>
            {sortedCards}
          </div>
        </ct-vstack>
      ),
    };
  }
);
