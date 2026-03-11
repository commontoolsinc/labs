/// <cts-enable />
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
  wish,
  Writable,
} from "commontools";

// ===== Helpers =====

function formatStars(n: number): string {
  if (n >= 10000) return Math.round(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function classificationColor(c: string | null): string {
  if (c === "accelerating") return "var(--ct-color-green-500)";
  if (c === "linear") return "var(--ct-color-blue-400)";
  if (c === "decelerating") return "var(--ct-color-amber-400)";
  return "var(--ct-color-gray-300)";
}

function sparklineColor(c: string | null): string {
  if (c === "accelerating") return "#22c55e";
  if (c === "linear") return "#60a5fa";
  if (c === "decelerating") return "#f59e0b";
  return "#9ca3af";
}

function badgeBg(c: string | null): string {
  if (c === "accelerating") return "#dcfce7";
  if (c === "linear") return "#dbeafe";
  if (c === "decelerating") return "#fef3c7";
  return "#f3f4f6";
}

function badgeFg(c: string | null): string {
  if (c === "accelerating") return "#15803d";
  if (c === "linear") return "#1d4ed8";
  if (c === "decelerating") return "#92400e";
  return "#6b7280";
}

function classificationExplanation(c: string | null): string {
  if (c === "accelerating") return "Growth has sped up — recent months added stars faster than earlier periods.";
  if (c === "linear") return "Growth is steady — the repo gains stars at a roughly constant rate.";
  if (c === "decelerating") return "Growth has slowed — earlier periods added stars faster than recent months.";
  return "Computing growth trend...";
}

function errorTitle(err: string): string {
  if (err.includes("401")) return "Invalid token";
  if (err.includes("403") || err.includes("429") || err.includes("rate limit")) return "Rate limit reached";
  if (err.includes("404")) return "Repo not found";
  return "Could not reach GitHub";
}

function errorDetail(err: string): string {
  if (err.includes("401")) return "Update the GitHub token in the header.";
  if (err.includes("403") || err.includes("429") || err.includes("rate limit")) return "Add a GitHub token in the header to continue.";
  if (err.includes("404")) return "Check the owner/name and try removing and re-adding.";
  return "Check your connection.";
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
    const parsed = parseSingleRepo(line);
    if (parsed) results.push(parsed);
  }
  return results;
}

function parseSingleRepo(line: string): ParsedRepo | null {
  // Markdown link: [label](url)
  const mdMatch = line.match(/\[.*?\]\((https?:\/\/github\.com\/([^/\s]+)\/([^/\s)]+))[^)]*\)/);
  if (mdMatch) {
    return makeRepo(mdMatch[2], mdMatch[3]);
  }
  // Full URL
  const urlMatch = line.match(/https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/);
  if (urlMatch) {
    return makeRepo(urlMatch[1], urlMatch[2]);
  }
  // owner/repo
  const bareMatch = line.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (bareMatch) {
    return makeRepo(bareMatch[1], bareMatch[2]);
  }
  return null;
}

function makeRepo(owner: string, repo: string): ParsedRepo {
  const cleanRepo = repo.replace(/\.git$/, "");
  return { owner, repo: cleanRepo, key: `${owner}/${cleanRepo}`.toLowerCase() };
}

// ===== Growth Series =====

interface StarDataPoint {
  x: number;
  y: number;
}

interface StargazerEntry {
  starred_at: string;
}

function buildGrowthSeries(
  stargazerPages: (StargazerEntry[] | null)[],
  totalStars: number,
  createdAt: string | null,
): StarDataPoint[] {
  const timestamps: number[] = [];
  for (const page of stargazerPages) {
    if (!page) continue;
    for (const entry of page) {
      if (entry.starred_at) {
        timestamps.push(new Date(entry.starred_at).getTime());
      }
    }
  }

  if (timestamps.length === 0) {
    return buildEstimatedCurve(totalStars, createdAt);
  }

  timestamps.sort((a, b) => a - b);
  const scaleFactor = totalStars > 0 ? totalStars / timestamps.length : 1;
  return timestamps.map((ts, i) => ({ x: ts, y: Math.round((i + 1) * scaleFactor) }));
}

function buildEstimatedCurve(totalStars: number, createdAt: string | null): StarDataPoint[] {
  const now = Date.now();
  if (!createdAt) {
    return [
      { x: now - 30 * 24 * 60 * 60 * 1000, y: 0 },
      { x: now, y: Math.max(0, totalStars) },
    ];
  }
  const created = new Date(createdAt).getTime();
  const totalMonths = Math.max(1, (now - created) / (30 * 24 * 60 * 60 * 1000));
  const steps = 12;
  const points: StarDataPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = created + (i / steps) * (now - created);
    const monthsIn = (t - created) / (30 * 24 * 60 * 60 * 1000);
    const y = Math.round(totalStars * Math.sqrt(monthsIn / totalMonths));
    points.push({ x: t, y });
  }
  return points;
}

function classifyGrowth(series: StarDataPoint[]): "accelerating" | "linear" | "decelerating" | null {
  if (series.length < 4) return null;
  const mid = Math.floor(series.length / 2);
  const firstHalfStars = series[mid].y - series[0].y;
  const firstHalfTime = series[mid].x - series[0].x;
  const secondHalfStars = series[series.length - 1].y - series[mid].y;
  const secondHalfTime = series[series.length - 1].x - series[mid].x;
  if (firstHalfTime === 0 || secondHalfTime === 0) return "linear";
  const firstRate = firstHalfStars / firstHalfTime;
  const secondRate = secondHalfStars / secondHalfTime;
  const ratio = firstRate > 0 ? secondRate / firstRate : 1;
  if (ratio > 1.25) return "accelerating";
  if (ratio < 0.75) return "decelerating";
  return "linear";
}

function computeGrowthRate(series: StarDataPoint[]): number {
  if (series.length < 2) return 0;
  const last = series[series.length - 1];
  const prev = series[Math.max(0, series.length - 4)];
  const timeDiff = last.x - prev.x;
  if (timeDiff === 0) return 0;
  return (last.y - prev.y) / timeDiff;
}

// ===== Page sampling =====

function samplePages(totalStars: number): number[] {
  if (totalStars === 0) return [1];
  const lastPage = Math.ceil(totalStars / 100);
  if (lastPage <= 5) {
    return Array.from({ length: Math.min(lastPage, 5) }, (_, i) => i + 1);
  }
  return [
    1,
    Math.max(1, Math.round(lastPage / 4)),
    Math.max(1, Math.round(lastPage / 2)),
    Math.max(1, Math.round((3 * lastPage) / 4)),
    lastPage,
  ];
}

// ===== Auth headers =====

function stargazerHeaders(token: string): FetchOptions {
  const opts: FetchOptions = {};
  if (token.trim()) {
    opts.headers = {
      Accept: "application/vnd.github.star+json",
      Authorization: `Bearer ${token.trim()}`,
    };
  } else {
    opts.headers = { Accept: "application/vnd.github.star+json" };
  }
  return opts;
}

function repoInfoOpts(token: string): FetchOptions {
  if (token.trim()) {
    return { headers: { Authorization: `Bearer ${token.trim()}` } };
  }
  return {};
}

// ===== GitHub API URLs =====

function starPageUrl(owner: string, repo: string, page: number): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/stargazers?per_page=100&page=${page}`;
}

// ===== Repo Entry =====

interface RepoEntry {
  owner: string;
  repoName: string;
  key: string;
}

// ===== GitHub Repo Info type =====

interface GithubRepoInfo {
  stargazers_count: number;
  description: string | null;
  language: string | null;
  created_at: string;
  forks_count: number;
}

// ===== RepoCard Sub-Pattern =====

interface RepoCardInput {
  entry: RepoEntry;
  githubToken: string;
  onSelect: Stream<{ key: string }>;
  onRemove: Stream<{ key: string }>;
}

interface RepoCardOutput {
  [NAME]: string;
  [UI]: VNode;
  key: string;
  repoName: string;
  owner: string;
  starCount: number;
  growthRate: number;
  growthClassification: string | null;
  growthSeries: StarDataPoint[];
  isLoading: boolean;
  hasError: boolean;
  errorMsg: string;
  description: string | null;
  language: string | null;
  createdAt: string | null;
  forkCount: number;
  githubUrl: string;
}

const RepoCard = pattern<RepoCardInput, RepoCardOutput>(
  ({ entry, githubToken, onSelect, onRemove }) => {
    // entry comes from visibleRepos.map() and is a reactive proxy — access its
    // properties inside computed() to stay inside a reactive context.
    const owner = computed(() => (entry as RepoEntry).owner);
    const repoName = computed(() => (entry as RepoEntry).repoName);
    const key = computed(() => (entry as RepoEntry).key);
    const githubUrl = computed(() => `https://github.com/${owner}/${repoName}`);
    const repoApiUrl = computed(() => `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`);

    // Fetch repo info
    const repoInfoFetch = fetchData<GithubRepoInfo>({
      url: repoApiUrl,
      mode: "json",
      options: computed(() => repoInfoOpts(githubToken)),
    });

    const repoInfoDone = computed(() => !!(repoInfoFetch.result || repoInfoFetch.error));

    // Derived fields from repo info
    const starCount = computed(() => (repoInfoFetch.result as GithubRepoInfo | null)?.stargazers_count ?? 0);
    const description = computed(() => (repoInfoFetch.result as GithubRepoInfo | null)?.description ?? null);
    const language = computed(() => (repoInfoFetch.result as GithubRepoInfo | null)?.language ?? null);
    const createdAt = computed(() => (repoInfoFetch.result as GithubRepoInfo | null)?.created_at ?? null);
    const forkCount = computed(() => (repoInfoFetch.result as GithubRepoInfo | null)?.forks_count ?? 0);

    // Determine pages to sample
    const pagesToFetch = computed(() => {
      if (!repoInfoDone) return [] as number[];
      return samplePages(starCount);
    });

    // Sequential chaining: page N only starts after page N-1 completes
    const page0Url = computed(() =>
      repoInfoDone && pagesToFetch.length > 0
        ? starPageUrl(owner, repoName, pagesToFetch[0])
        : ""
    );

    const page0 = fetchData<StargazerEntry[]>({
      url: page0Url,
      mode: "json",
      options: computed(() => stargazerHeaders(githubToken)),
    });

    const page1Url = computed(() => {
      if (!(page0.result || page0.error)) return "";
      if (pagesToFetch.length < 2) return "";
      return starPageUrl(owner, repoName, pagesToFetch[1]);
    });
    const page1 = fetchData<StargazerEntry[]>({
      url: page1Url,
      mode: "json",
      options: computed(() => stargazerHeaders(githubToken)),
    });

    const page2Url = computed(() => {
      if (!(page1.result || page1.error)) return "";
      if (pagesToFetch.length < 3) return "";
      return starPageUrl(owner, repoName, pagesToFetch[2]);
    });
    const page2 = fetchData<StargazerEntry[]>({
      url: page2Url,
      mode: "json",
      options: computed(() => stargazerHeaders(githubToken)),
    });

    const page3Url = computed(() => {
      if (!(page2.result || page2.error)) return "";
      if (pagesToFetch.length < 4) return "";
      return starPageUrl(owner, repoName, pagesToFetch[3]);
    });
    const page3 = fetchData<StargazerEntry[]>({
      url: page3Url,
      mode: "json",
      options: computed(() => stargazerHeaders(githubToken)),
    });

    const page4Url = computed(() => {
      if (!(page3.result || page3.error)) return "";
      if (pagesToFetch.length < 5) return "";
      return starPageUrl(owner, repoName, pagesToFetch[4]);
    });
    const page4 = fetchData<StargazerEntry[]>({
      url: page4Url,
      mode: "json",
      options: computed(() => stargazerHeaders(githubToken)),
    });

    // Collect available pages
    const stargazerPages = computed(() => {
      const pages: (StargazerEntry[] | null)[] = [];
      if (page0Url && (page0.result || page0.error)) {
        pages.push((page0.result as StargazerEntry[] | null) ?? null);
      }
      if (page1Url && (page1.result || page1.error)) {
        pages.push((page1.result as StargazerEntry[] | null) ?? null);
      }
      if (page2Url && (page2.result || page2.error)) {
        pages.push((page2.result as StargazerEntry[] | null) ?? null);
      }
      if (page3Url && (page3.result || page3.error)) {
        pages.push((page3.result as StargazerEntry[] | null) ?? null);
      }
      if (page4Url && (page4.result || page4.error)) {
        pages.push((page4.result as StargazerEntry[] | null) ?? null);
      }
      return pages;
    });

    const growthSeries = computed(() =>
      buildGrowthSeries(stargazerPages, starCount, createdAt)
    );

    const growthClassification = computed(() => classifyGrowth(growthSeries));
    const growthRate = computed(() => computeGrowthRate(growthSeries));

    const errorMsg = computed(() => {
      if (repoInfoFetch.error) return String(repoInfoFetch.error);
      if (page0.error) return String(page0.error);
      return "";
    });
    const hasError = computed(() => !!errorMsg);
    const isLoading = computed(() => !!(repoInfoFetch.pending || (!repoInfoFetch.result && !repoInfoFetch.error)));

    const borderColor = computed(() =>
      hasError ? "var(--ct-color-red-400)" : classificationColor(growthClassification)
    );

    return {
      [NAME]: computed(() => `${owner}/${repoName}`),
      [UI]: (
        <ct-card style={computed(() => `border-left: 3px solid ${borderColor}; min-height: 160px;`)}>
          <ct-vstack gap="2">
            {/* Top row */}
            <ct-hstack justify="between" align="start">
              <ct-vstack gap="0">
                <ct-heading
                  level={6}
                  style="font-size: 0.9rem; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px;"
                >
                  {repoName}
                </ct-heading>
                <span style={{ fontSize: "0.75rem", color: "var(--ct-color-gray-500)" }}>
                  {owner}
                </span>
              </ct-vstack>
              <ct-button variant="ghost" size="sm" onClick={() => onRemove.send({ key })}>
                ×
              </ct-button>
            </ct-hstack>

            {/* Loading skeleton */}
            {isLoading
              ? (
                <ct-vstack gap="2">
                  <div
                    style={{
                      height: "1rem",
                      width: "40%",
                      backgroundColor: "var(--ct-color-gray-100)",
                      borderRadius: "0.25rem",
                    }}
                  />
                  <div
                    style={{
                      height: "48px",
                      backgroundColor: "var(--ct-color-gray-100)",
                      borderRadius: "0.25rem",
                    }}
                  />
                  <div
                    style={{
                      height: "0.75rem",
                      width: "30%",
                      backgroundColor: "var(--ct-color-gray-100)",
                      borderRadius: "9999px",
                    }}
                  />
                </ct-vstack>
              )
              : hasError
              ? (
                /* Error state */
                <ct-vstack gap="1" style="padding: 0.5rem 0;">
                  <span style={{ fontSize: "0.8rem", color: "var(--ct-color-red-600)", fontWeight: "500" }}>
                    {computed(() => errorTitle(errorMsg))}
                  </span>
                  <span style={{ fontSize: "0.75rem", color: "var(--ct-color-red-500)" }}>
                    {computed(() => errorDetail(errorMsg))}
                  </span>
                </ct-vstack>
              )
              : (
                /* Data state */
                <ct-vstack gap="2">
                  {/* Stars + language */}
                  <ct-hstack gap="3" align="center">
                    <ct-hstack gap="1" align="center">
                      <span style={{ fontSize: "1rem" }}>★</span>
                      <span style={{ fontWeight: "600", fontSize: "0.95rem" }}>
                        {computed(() => formatStars(starCount))}
                      </span>
                    </ct-hstack>
                    {language
                      ? (
                        <span style={{ fontSize: "0.75rem", color: "var(--ct-color-gray-400)", backgroundColor: "var(--ct-color-gray-100)", padding: "0.125rem 0.5rem", borderRadius: "9999px" }}>
                          {language}
                        </span>
                      )
                      : null}
                  </ct-hstack>

                  {/* Sparkline */}
                  {growthSeries.length > 0
                    ? (
                      <div style={{ cursor: "pointer", height: "48px" }} onClick={() => onSelect.send({ key })}>
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
                        <span style={{ fontSize: "0.7rem", color: "var(--ct-color-gray-400)" }}>Loading sparkline...</span>
                      </div>
                    )}

                  {/* Bottom row */}
                  <ct-hstack justify="between" align="center">
                    {growthClassification
                      ? (
                        <span style={computed(() => ({
                          fontSize: "0.7rem",
                          fontWeight: "600",
                          padding: "0.125rem 0.5rem",
                          borderRadius: "9999px",
                          backgroundColor: badgeBg(growthClassification),
                          color: badgeFg(growthClassification),
                        }))}>
                          {growthClassification}
                        </span>
                      )
                      : (
                        <span style={{ fontSize: "0.7rem", color: "var(--ct-color-gray-400)" }}>...</span>
                      )}
                    <ct-hstack gap="2" align="center">
                      <ct-button
                        variant="ghost"
                        size="sm"
                        style="font-size: 0.75rem; padding: 0.125rem 0.5rem;"
                        onClick={() => onSelect.send({ key })}
                      >
                        View detail
                      </ct-button>
                      <a
                        href={githubUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: "0.75rem", color: "var(--ct-color-blue-600)", textDecoration: "none" }}
                      >
                        GitHub ↗
                      </a>
                    </ct-hstack>
                  </ct-hstack>
                </ct-vstack>
              )}
          </ct-vstack>
        </ct-card>
      ),
      key,
      repoName,
      owner,
      starCount,
      growthRate,
      growthClassification,
      growthSeries,
      isLoading,
      hasError,
      errorMsg,
      description,
      language,
      createdAt,
      forkCount,
      githubUrl,
    };
  }
);

// ===== Main StarTracker Pattern =====

interface StarTrackerInput {
  repos?: Writable<Default<RepoEntry[], []>>;
  githubToken?: Writable<Default<string, "">>;
  sortKey?: Writable<Default<string, "stars">>;
  visibleCount?: Writable<Default<number, 25>>;
  selectedKey?: Writable<Default<string, "">>;
}

interface StarTrackerOutput {
  [NAME]: string;
  [UI]: VNode;
  repos: RepoEntry[];
  githubToken: string;
  sortKey: string;
  visibleCount: number;
  selectedKey: string;
  addRepos: Stream<{ input: string }>;
  removeRepo: Stream<{ key: string }>;
  selectRepo: Stream<{ key: string }>;
  closeModal: Stream<void>;
  showMore: Stream<void>;
  setSortKey: Stream<{ key: string }>;
}

export default pattern<StarTrackerInput, StarTrackerOutput>(
  ({ repos, githubToken, sortKey, visibleCount, selectedKey }) => {
    // Try to pre-populate token from wish #githubToken
    const tokenWish = wish<{ value: string }>({ query: "#githubToken" });
    const wishedToken = computed(() => tokenWish.result?.value ?? "");

    const repoInput = Writable.of("");
    const inputError = Writable.of(false);

    // Actions
    const addRepos = action(({ input }: { input: string }) => {
      // Empty/whitespace input is a no-op — don't show an error
      if (!input.trim()) return;
      const parsed = parseRepoInput(input);
      if (parsed.length === 0) {
        inputError.set(true);
        return;
      }
      inputError.set(false);
      const currentKeys = new Set(repos.get().map((r) => r.key));
      for (const p of parsed) {
        if (!currentKeys.has(p.key)) {
          repos.push({ owner: p.owner, repoName: p.repo, key: p.key });
          currentKeys.add(p.key);
        }
      }
      repoInput.set("");
    });

    const removeRepo = action(({ key }: { key: string }) => {
      repos.set(repos.get().filter((r) => r.key !== key));
      if (selectedKey.get() === key) {
        selectedKey.set("");
      }
    });

    const selectRepo = action(({ key }: { key: string }) => {
      selectedKey.set(key);
    });

    const closeModal = action(() => {
      selectedKey.set("");
    });

    const showMore = action(() => {
      visibleCount.set(visibleCount.get() + 25);
    });

    const setSortKey = action(({ key }: { key: string }) => {
      sortKey.set(key);
    });

    // Paginated slice (concurrency gate — only create sub-patterns for visible repos)
    const visibleRepos = computed(() => repos.get().slice(0, visibleCount.get()));

    // Map to RepoCard sub-patterns
    const repoCards = visibleRepos.map((entry: RepoEntry) => (
      <RepoCard
        entry={entry}
        githubToken={computed(() => githubToken.get() || wishedToken)}
        onSelect={selectRepo}
        onRemove={removeRepo}
      />
    ));

    // View-layer sort — sort the OUTPUT references, not the input list
    // Cast to any[] to access sub-pattern output properties reactively
    const sortedCards = computed(() => {
      const cards = repoCards as any[];
      const k = sortKey.get();
      const sorted = [...cards];
      if (k === "stars") {
        sorted.sort((a, b) => {
          if (a.isLoading && !b.isLoading) return 1;
          if (!a.isLoading && b.isLoading) return -1;
          return (b.starCount ?? 0) - (a.starCount ?? 0);
        });
      } else if (k === "growth_rate") {
        sorted.sort((a, b) => {
          if (a.isLoading && !b.isLoading) return 1;
          if (!a.isLoading && b.isLoading) return -1;
          return (b.growthRate ?? 0) - (a.growthRate ?? 0);
        });
      } else {
        sorted.sort((a, b) =>
          `${a.owner}/${a.repoName}`.localeCompare(`${b.owner}/${b.repoName}`)
        );
      }
      return sorted;
    });

    // Selected card for modal (closes reactively if repo removed)
    const selectedCard = computed(() => {
      const k = selectedKey.get();
      if (!k) return null;
      if (!repos.get().find((r) => r.key === k)) return null;
      const cards = repoCards as any[];
      return (cards.find((c) => c.key === k) as RepoCardOutput | undefined) ?? null;
    });

    const hasRepos = computed(() => repos.get().length > 0);
    const hasMore = computed(() => repos.get().length > visibleCount.get());
    const remaining = computed(() => Math.max(0, repos.get().length - visibleCount.get()));
    const repoCount = computed(() => repos.get().length);

    const sortItems = [
      { label: "Stars", value: "stars" },
      { label: "Growth", value: "growth_rate" },
      { label: "Name", value: "name" },
    ];

    return {
      [NAME]: computed(() => `GitHub Star Tracker (${repoCount})`),
      [UI]: (
        <ct-screen>
          {/* Header */}
          <div
            style={{
              backgroundColor: "var(--ct-color-gray-50)",
              borderBottom: "1px solid var(--ct-color-gray-200)",
              padding: "0.75rem 1rem",
            }}
          >
            <ct-hstack gap="3" align="center" justify="between">
              <ct-heading level={5}>GitHub Star Tracker</ct-heading>
              <ct-hstack gap="2" align="center">
                <span style={{ fontSize: "0.75rem", color: "var(--ct-color-gray-500)" }}>
                  GitHub Token
                </span>
                <ct-input
                  $value={githubToken}
                  placeholder="ghp_... (optional)"
                  style="width: 220px; font-family: monospace; font-size: 0.75rem;"
                />
              </ct-hstack>
            </ct-hstack>
            <div style={{ fontSize: "0.7rem", color: "var(--ct-color-amber-600)", marginTop: "0.25rem" }}>
              Reload after adding a token to retry rate-limited repos.
            </div>
          </div>

          {/* Main body */}
          <ct-vscroll style="flex: 1;">
            {hasRepos
              ? (
                /* With-repos view */
                <ct-vstack gap="4" style="padding: 1rem; max-width: 1200px; margin: 0 auto; align-items: stretch;">
                  {/* Input area */}
                  <ct-vstack gap="2">
                    <ct-textarea
                      $value={repoInput}
                      placeholder="Add more repos — one per line"
                      style="width: 100%; min-height: 72px; font-family: monospace; font-size: 0.875rem;"
                    />
                    <ct-hstack gap="2" justify="between" align="center">
                      <span style={{ fontSize: "0.75rem", color: "var(--ct-color-gray-400)" }}>
                        Click Add to submit
                      </span>
                      <ct-button
                        variant="primary"
                        size="sm"
                        onClick={() => addRepos.send({ input: repoInput.get() })}
                      >
                        Add
                      </ct-button>
                    </ct-hstack>
                    {inputError
                      ? (
                        <span style={{ fontSize: "0.75rem", color: "var(--ct-color-red-600)" }}>
                          No valid repo identifiers found. Try: owner/repo or a GitHub URL.
                        </span>
                      )
                      : null}
                  </ct-vstack>

                  {/* Toolbar */}
                  <ct-hstack gap="3" align="center" justify="between" style="padding: 0.25rem 0;">
                    <span style={{ fontSize: "0.875rem", color: "var(--ct-color-gray-600)", fontWeight: "500" }}>
                      {repoCount} repos tracked
                    </span>
                    <ct-hstack gap="2" align="center">
                      <span style={{ fontSize: "0.75rem", color: "var(--ct-color-gray-500)" }}>
                        Sort:
                      </span>
                      <ct-select
                        $value={sortKey}
                        items={sortItems}
                        style="font-size: 0.875rem;"
                      />
                    </ct-hstack>
                  </ct-hstack>

                  {/* Card grid */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "0.75rem" }}>
                    {repoCards}
                  </div>

                  {/* Show more */}
                  {hasMore
                    ? (
                      <div style={{ textAlign: "center", paddingTop: "0.5rem" }}>
                        <ct-button variant="ghost" onClick={() => showMore.send()}>
                          Show more ({remaining} remaining)
                        </ct-button>
                      </div>
                    )
                    : null}
                </ct-vstack>
              )
              : (
                /* Empty state */
                <ct-vstack gap="4" style="padding: 2rem 1rem; max-width: 860px; margin: 0 auto; align-items: stretch;">
                  <div style={{ textAlign: "center", padding: "3rem 1rem" }}>
                    <ct-vstack gap="3" style="align-items: center;">
                      <ct-heading level={4}>Track your GitHub stars</ct-heading>
                      <span style={{ color: "var(--ct-color-gray-500)", maxWidth: "400px", lineHeight: "1.5", display: "block" }}>
                        Paste a list of repositories to see live star counts and growth trends.
                      </span>
                    </ct-vstack>
                  </div>

                  <ct-vstack gap="2">
                    <ct-textarea
                      $value={repoInput}
                      placeholder={"one per line — try:\n  owner/repo\n  https://github.com/owner/repo\n  [My Project](https://github.com/owner/repo)"}
                      style="width: 100%; min-height: 96px; font-family: monospace; font-size: 0.875rem; line-height: 1.6;"
                    />
                    <ct-hstack gap="2" justify="between" align="center">
                      <span style={{ fontSize: "0.75rem", color: "var(--ct-color-gray-400)" }}>
                        Click to add repositories
                      </span>
                      <ct-button
                        variant="primary"
                        onClick={() => addRepos.send({ input: repoInput.get() })}
                      >
                        Add Repositories
                      </ct-button>
                    </ct-hstack>
                    {inputError
                      ? (
                        <span style={{ fontSize: "0.75rem", color: "var(--ct-color-red-600)" }}>
                          No valid repo identifiers found. Try: owner/repo or a GitHub URL.
                        </span>
                      )
                      : null}
                  </ct-vstack>
                </ct-vstack>
              )}
          </ct-vscroll>

          {/* Detail Modal — rendered at screen level to overlay everything */}
          {selectedCard
            ? (
              <div
                style={{
                  position: "fixed",
                  inset: "0",
                  backgroundColor: "rgba(0,0,0,0.45)",
                  zIndex: "50",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "1rem",
                }}
                onClick={() => closeModal.send()}
              >
                {/* Inner panel — use a nested container; clicks inside will bubble to backdrop.
                    We prevent that by checking in a close action that only fires on backdrop.
                    Alternative: wrap inner content in a component that intercepts. Since we can't
                    stopPropagation, we put the close handler on backdrop and the inner panel
                    uses a onClick that re-selects (no-op) to absorb the click — but
                    this approach would still bubble. Best approach: use pointer-events on
                    a separate backdrop layer behind the panel. */}
                <div style={{ position: "fixed", inset: "0", zIndex: "49" }} onClick={() => closeModal.send()} />
                <div
                  style={{
                    backgroundColor: "white",
                    borderRadius: "0.75rem",
                    width: "100%",
                    maxWidth: "560px",
                    maxHeight: "90vh",
                    overflow: "auto",
                    boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
                    position: "relative",
                    zIndex: "51",
                  }}
                >
                  <ct-vstack gap="0">
                    {/* Modal header */}
                    <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--ct-color-gray-200)" }}>
                      <ct-hstack justify="between" align="start">
                        <ct-vstack gap="0">
                          <ct-heading level={5} style="margin: 0;">
                            {computed(() => selectedCard?.repoName ?? "")}
                          </ct-heading>
                          <span style={{ fontSize: "0.8rem", color: "var(--ct-color-gray-500)" }}>
                            {computed(() => selectedCard?.owner ?? "")}
                          </span>
                        </ct-vstack>
                        <ct-button variant="ghost" size="sm" onClick={() => closeModal.send()}>
                          ×
                        </ct-button>
                      </ct-hstack>
                    </div>

                    {/* Modal body */}
                    <ct-vstack gap="4" style="padding: 1.25rem;">
                      {/* Large chart */}
                      {computed(() => (selectedCard?.growthSeries?.length ?? 0) > 0)
                        ? (
                          <ct-chart height={200} xAxis yAxis xType="time" style="width: 100%;">
                            <ct-area-mark
                              $data={computed(() => selectedCard?.growthSeries ?? [])}
                              x="x"
                              y="y"
                              color={computed(() => sparklineColor(selectedCard?.growthClassification ?? null))}
                              opacity={0.15}
                              curve="monotone"
                            />
                            <ct-line-mark
                              $data={computed(() => selectedCard?.growthSeries ?? [])}
                              x="x"
                              y="y"
                              color={computed(() => sparklineColor(selectedCard?.growthClassification ?? null))}
                              strokeWidth={2}
                              curve="monotone"
                            />
                          </ct-chart>
                        )
                        : (
                          <div
                            style={{
                              height: "200px",
                              backgroundColor: "var(--ct-color-gray-100)",
                              borderRadius: "0.375rem",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <span style={{ fontSize: "0.875rem", color: "var(--ct-color-gray-400)" }}>
                              Loading chart...
                            </span>
                          </div>
                        )}

                      {/* Metadata grid */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                        <ct-vstack gap="0">
                          <span style={{ fontSize: "0.7rem", color: "var(--ct-color-gray-400)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            Stars
                          </span>
                          <span style={{ fontSize: "0.9rem", fontWeight: "500" }}>
                            {computed(() => formatStars(selectedCard?.starCount ?? 0))}
                          </span>
                        </ct-vstack>
                        <ct-vstack gap="0">
                          <span style={{ fontSize: "0.7rem", color: "var(--ct-color-gray-400)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            Forks
                          </span>
                          <span style={{ fontSize: "0.9rem", fontWeight: "500" }}>
                            {computed(() => formatStars(selectedCard?.forkCount ?? 0))}
                          </span>
                        </ct-vstack>
                        <ct-vstack gap="0">
                          <span style={{ fontSize: "0.7rem", color: "var(--ct-color-gray-400)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            Language
                          </span>
                          <span style={{ fontSize: "0.9rem", fontWeight: "500" }}>
                            {computed(() => selectedCard?.language ?? "...")}
                          </span>
                        </ct-vstack>
                        <ct-vstack gap="0">
                          <span style={{ fontSize: "0.7rem", color: "var(--ct-color-gray-400)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            Created
                          </span>
                          <span style={{ fontSize: "0.9rem", fontWeight: "500" }}>
                            {computed(() => {
                              const d = selectedCard?.createdAt;
                              if (!d) return "...";
                              return new Date(d).toLocaleDateString();
                            })}
                          </span>
                        </ct-vstack>
                      </div>

                      {/* Description */}
                      <ct-vstack gap="0">
                        <span style={{ fontSize: "0.7rem", color: "var(--ct-color-gray-400)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                          Description
                        </span>
                        <span style={{ fontSize: "0.875rem", color: "var(--ct-color-gray-700)", lineHeight: "1.5" }}>
                          {computed(() => selectedCard?.description ?? "...")}
                        </span>
                      </ct-vstack>

                      {/* Growth classification */}
                      <div style={computed(() => ({
                        backgroundColor: badgeBg(selectedCard?.growthClassification ?? null),
                        padding: "0.75rem 1rem",
                        borderRadius: "0.5rem",
                      }))}>
                        <ct-vstack gap="1">
                          <span style={computed(() => ({
                            fontWeight: "600",
                            fontSize: "0.9rem",
                            color: badgeFg(selectedCard?.growthClassification ?? null),
                          }))}>
                            {computed(() => selectedCard?.growthClassification ?? "Loading...")}
                          </span>
                          <span style={computed(() => ({
                            fontSize: "0.8rem",
                            color: badgeFg(selectedCard?.growthClassification ?? null),
                            opacity: "0.85",
                          }))}>
                            {computed(() => classificationExplanation(selectedCard?.growthClassification ?? null))}
                          </span>
                        </ct-vstack>
                      </div>

                      {/* GitHub link */}
                      <ct-hstack justify="end">
                        <a
                          href={computed(() => selectedCard?.githubUrl ?? "")}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: "0.875rem", color: "var(--ct-color-blue-600)", textDecoration: "none", fontWeight: "500" }}
                        >
                          View on GitHub ↗
                        </a>
                      </ct-hstack>
                    </ct-vstack>
                  </ct-vstack>
                </div>
              </div>
            )
            : null}
        </ct-screen>
      ),
      repos,
      githubToken,
      sortKey,
      visibleCount,
      selectedKey,
      addRepos,
      removeRepo,
      selectRepo,
      closeModal,
      showMore,
      setSortKey,
    };
  }
);
