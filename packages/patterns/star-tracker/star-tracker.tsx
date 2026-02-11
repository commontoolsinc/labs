/// <cts-enable />
import {
  action,
  computed,
  Default,
  fetchData,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";

// === Types ===

export interface RepoEntry {
  owner: string;
  repo: string;
}

interface StarTrackerInput {
  repos: Writable<Default<RepoEntry[], []>>;
  githubToken: Writable<Default<string, "">>;
}

interface StarTrackerOutput {
  [NAME]: string;
  [UI]: VNode;
  repos: RepoEntry[];
  githubToken: string;
  addRepos: Stream<string>;
  removeRepo: Stream<RepoEntry>;
}

type RepoInfo = {
  stargazers_count: number;
  created_at: string;
};

type StarEvent = {
  starred_at: string;
};

interface CurvePoint {
  date: number;
  stars: number;
}

type GrowthFlag = "accelerating" | "linear" | "decelerating" | "unknown";

// === Pure helpers (module scope) ===

function formatStars(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
  return String(n);
}

function computeSamplePages(totalStars: number): number[] {
  const totalPages = Math.ceil(totalStars / 100);
  if (totalPages <= 0) return [];
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  return [
    1,
    Math.floor(totalPages / 4),
    Math.floor(totalPages / 2),
    Math.floor((3 * totalPages) / 4),
    totalPages,
  ];
}

function buildCurve(
  allEvents: StarEvent[][],
  samplePages: number[],
  totalStars: number,
): CurvePoint[] {
  const points: CurvePoint[] = [];
  for (let i = 0; i < samplePages.length; i++) {
    const events = allEvents[i];
    if (!events || !Array.isArray(events) || events.length === 0) continue;
    const pageNum = samplePages[i];
    const baseIndex = (pageNum - 1) * 100;
    const firstEvent = events[0];
    if (firstEvent?.starred_at) {
      points.push({
        date: new Date(firstEvent.starred_at).getTime(),
        stars: baseIndex + 1,
      });
    }
    const lastEvent = events[events.length - 1];
    if (lastEvent?.starred_at) {
      points.push({
        date: new Date(lastEvent.starred_at).getTime(),
        stars: baseIndex + events.length,
      });
    }
  }
  points.sort((a, b) => a.date - b.date);
  if (totalStars > 0) {
    points.push({ date: Date.now(), stars: totalStars });
  }
  return points;
}

function bucketCurve(points: CurvePoint[], buckets: number): CurvePoint[] {
  if (points.length < 2) return points;
  const minDate = points[0].date;
  const maxDate = points[points.length - 1].date;
  const range = maxDate - minDate;
  if (range <= 0) return points;
  const result: CurvePoint[] = [];
  for (let i = 0; i < buckets; i++) {
    const t = minDate + (range * i) / (buckets - 1);
    let lo = 0;
    let hi = points.length - 1;
    for (let j = 0; j < points.length - 1; j++) {
      if (points[j].date <= t && points[j + 1].date >= t) {
        lo = j;
        hi = j + 1;
        break;
      }
    }
    const pLo = points[lo];
    const pHi = points[hi];
    const frac = pHi.date === pLo.date
      ? 0
      : (t - pLo.date) / (pHi.date - pLo.date);
    result.push({
      date: t,
      stars: Math.round(pLo.stars + frac * (pHi.stars - pLo.stars)),
    });
  }
  return result;
}

function analyzeGrowth(points: CurvePoint[]): {
  flag: GrowthFlag;
  rate: number;
} {
  if (points.length < 3) return { flag: "unknown", rate: 0 };
  const derivs: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const dt = (points[i + 1].date - points[i].date) / (1000 * 60 * 60 * 24);
    const ds = points[i + 1].stars - points[i].stars;
    derivs.push(dt > 0 ? ds / dt : 0);
  }
  const recentDerivs = derivs.slice(-2);
  const rate = recentDerivs.reduce((s, v) => s + v, 0) / recentDerivs.length;
  const secondDerivs: number[] = [];
  for (let i = 0; i < derivs.length - 1; i++) {
    const dt = (points[i + 2].date - points[i].date) /
      (2 * 1000 * 60 * 60 * 24);
    secondDerivs.push(dt > 0 ? (derivs[i + 1] - derivs[i]) / dt : 0);
  }
  if (secondDerivs.length === 0) return { flag: "unknown", rate };
  const recentAccel = secondDerivs.slice(-3);
  const avgAccel = recentAccel.reduce((s, v) => s + v, 0) / recentAccel.length;
  const threshold = Math.max(Math.abs(rate) * 0.05, 0.01);
  let flag: GrowthFlag;
  if (avgAccel > threshold) flag = "accelerating";
  else if (avgAccel < -threshold) flag = "decelerating";
  else flag = "linear";
  return { flag, rate };
}

const FLAG_COLORS: Record<string, string> = {
  accelerating: "#22c55e",
  linear: "#eab308",
  decelerating: "#9ca3af",
  unknown: "#6b7280",
};

const FLAG_DOTS: Record<string, string> = {
  accelerating: "▲",
  linear: "→",
  decelerating: "▼",
  unknown: "·",
};

// === Sub-pattern for each repo row ===

interface RepoCardInput {
  owner: Default<string, "">;
  repo: Default<string, "">;
  githubToken: Default<string, "">;
}

export const RepoCard = pattern<RepoCardInput>(
  ({ owner, repo, githubToken }) => {
    const headers = computed(() => {
      const h: Record<string, string> = {};
      if (githubToken) h["Authorization"] = `Bearer ${githubToken}`;
      return h;
    });

    const starHeaders = computed(() => {
      const h: Record<string, string> = {
        Accept: "application/vnd.github.v3.star+json",
      };
      if (githubToken) h["Authorization"] = `Bearer ${githubToken}`;
      return h;
    });

    const repoUrl = computed(() => {
      if (owner && repo) return `https://api.github.com/repos/${owner}/${repo}`;
      return "";
    });

    const repoInfo = fetchData<RepoInfo>({
      url: repoUrl,
      mode: "json",
      options: computed(() => ({ headers: headers })),
    });

    const stars = computed(() => repoInfo.result?.stargazers_count ?? 0);
    const samplePages = computed(() => computeSamplePages(stars));

    const pageUrl0 = computed(() => {
      const pages = samplePages;
      if (!owner || !repo || 0 >= pages.length) return "";
      return `https://api.github.com/repos/${owner}/${repo}/stargazers?page=${
        pages[0]
      }&per_page=100`;
    });
    const pageUrl1 = computed(() => {
      const pages = samplePages;
      if (!owner || !repo || 1 >= pages.length) return "";
      return `https://api.github.com/repos/${owner}/${repo}/stargazers?page=${
        pages[1]
      }&per_page=100`;
    });
    const pageUrl2 = computed(() => {
      const pages = samplePages;
      if (!owner || !repo || 2 >= pages.length) return "";
      return `https://api.github.com/repos/${owner}/${repo}/stargazers?page=${
        pages[2]
      }&per_page=100`;
    });
    const pageUrl3 = computed(() => {
      const pages = samplePages;
      if (!owner || !repo || 3 >= pages.length) return "";
      return `https://api.github.com/repos/${owner}/${repo}/stargazers?page=${
        pages[3]
      }&per_page=100`;
    });
    const pageUrl4 = computed(() => {
      const pages = samplePages;
      if (!owner || !repo || 4 >= pages.length) return "";
      return `https://api.github.com/repos/${owner}/${repo}/stargazers?page=${
        pages[4]
      }&per_page=100`;
    });

    const starOpts = computed(() => ({ headers: starHeaders }));

    const page0 = fetchData<StarEvent[]>({
      url: pageUrl0,
      mode: "json",
      options: starOpts,
    });
    const page1 = fetchData<StarEvent[]>({
      url: pageUrl1,
      mode: "json",
      options: starOpts,
    });
    const page2 = fetchData<StarEvent[]>({
      url: pageUrl2,
      mode: "json",
      options: starOpts,
    });
    const page3 = fetchData<StarEvent[]>({
      url: pageUrl3,
      mode: "json",
      options: starOpts,
    });
    const page4 = fetchData<StarEvent[]>({
      url: pageUrl4,
      mode: "json",
      options: starOpts,
    });

    const curvePoints = computed((): CurvePoint[] => {
      const allPages = [
        page0.result,
        page1.result,
        page2.result,
        page3.result,
        page4.result,
      ].map((r) => (Array.isArray(r) ? r : []));
      const pages = samplePages;
      if (pages.length === 0) return [];
      const raw = buildCurve(allPages as StarEvent[][], pages, stars);
      if (raw.length < 2) return raw;
      return bucketCurve(raw, 20);
    });

    const growth = computed(() => analyzeGrowth(curvePoints));
    const growthFlag = computed((): GrowthFlag => growth.flag);
    const growthRate = computed(() => growth.rate);

    const sparklineBars = computed(() => {
      const pts = curvePoints;
      if (pts.length === 0) return [];
      const max = Math.max(...pts.map((p) => p.stars));
      return pts.map((p, i) => {
        const pct = max > 0 ? (p.stars / max) * 100 : 0;
        let color = FLAG_COLORS.linear;
        if (i > 0 && i < pts.length - 1) {
          const prev = pts[i - 1].stars;
          const next = pts[i + 1].stars;
          const d1 = p.stars - prev;
          const d2 = next - p.stars;
          if (d2 > d1 * 1.1) color = FLAG_COLORS.accelerating;
          else if (d2 < d1 * 0.9) color = FLAG_COLORS.decelerating;
        }
        return { pct, color };
      });
    });

    return {
      [NAME]: computed(() => `${owner}/${repo}`),
      [UI]: (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "6px 10px",
            fontSize: "13px",
            fontFamily: "system-ui, sans-serif",
            borderBottom: "1px solid var(--ct-color-border, #e5e7eb)",
            minHeight: "36px",
          }}
        >
          <span
            style={computed(() => ({
              color: FLAG_COLORS[growthFlag] || "#6b7280",
              fontWeight: "bold",
              fontSize: "14px",
              width: "16px",
              textAlign: "center" as const,
            }))}
          >
            {computed(() => FLAG_DOTS[growthFlag] || "·")}
          </span>

          <a
            href={computed(() => `https://github.com/${owner}/${repo}`)}
            target="_blank"
            style={{
              color: "var(--ct-color-text, #111)",
              textDecoration: "none",
              fontWeight: 500,
              width: "200px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {computed(() => `${owner}/${repo}`)}
          </a>

          <span
            style={{
              color: "var(--ct-color-gray-500, #6b7280)",
              width: "65px",
              textAlign: "right" as const,
            }}
          >
            {computed(() => stars === 0 ? "..." : `★ ${formatStars(stars)}`)}
          </span>

          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: "1px",
              height: "24px",
              width: "100px",
              flexShrink: "0",
            }}
          >
            {computed(() =>
              sparklineBars.map((bar: { pct: number; color: string }) => (
                <div
                  style={{
                    flex: "1",
                    height: `${bar.pct}%`,
                    backgroundColor: bar.color,
                    borderRadius: "1px 1px 0 0",
                    minHeight: "1px",
                  }}
                />
              ))
            )}
          </div>

          <span
            style={computed(() => ({
              color: FLAG_COLORS[growthFlag] || "#6b7280",
              width: "70px",
              textAlign: "right" as const,
              fontSize: "12px",
            }))}
          >
            {computed(() => {
              const r = growthRate;
              if (r === 0 && stars === 0) return "";
              if (Math.abs(r) < 0.1) return "<0.1/d";
              return `+${r.toFixed(1)}/d`;
            })}
          </span>
        </div>
      ),
      owner,
      repo,
      stars,
      growthRate,
      growthFlag,
    };
  },
);

// === Main pattern ===

type SortMode = "stars" | "growth" | "name";

export default pattern<StarTrackerInput, StarTrackerOutput>(
  ({ repos, githubToken }) => {
    const addText = Writable.of("");
    const sortMode = Writable.of<SortMode>("stars");

    const addRepos = action((inputText: string) => {
      const text = inputText || addText.get();
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("/"));
      const current = repos.get();
      const newEntries: RepoEntry[] = [];
      for (const line of lines) {
        const match = line.match(
          /(?:github\.com\/)?([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)/,
        );
        if (match) {
          const o = match[1];
          const r = match[2];
          const exists = current.some(
            (e) => e && e.owner === o && e.repo === r,
          );
          if (!exists) {
            newEntries.push({ owner: o, repo: r });
          }
        }
      }
      if (newEntries.length > 0) {
        repos.set([...current, ...newEntries]);
      }
      addText.set("");
    });

    const removeRepo = action(({ owner, repo }: RepoEntry) => {
      const current = repos.get();
      repos.set(
        current.filter((r) => r && !(r.owner === owner && r.repo === repo)),
      );
    });

    const addFromInput = action(() => {
      addRepos.send(addText.get());
    });

    const totalCount = computed(() => repos.get().length);

    return {
      [NAME]: computed(() => `Star Tracker (${totalCount} repos)`),
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header" gap="2">
            <ct-heading level={4}>
              Star Tracker ({totalCount} repos)
            </ct-heading>
            <ct-hstack gap="2" align="center">
              <span
                style={{
                  fontSize: "12px",
                  color: "var(--ct-color-gray-500)",
                }}
              >
                Sort:
              </span>
              <ct-tabs $value={sortMode}>
                <ct-tab-list>
                  <ct-tab value="stars">Stars</ct-tab>
                  <ct-tab value="growth">Growth</ct-tab>
                  <ct-tab value="name">Name</ct-tab>
                </ct-tab-list>
              </ct-tabs>
            </ct-hstack>
          </ct-vstack>

          <ct-vscroll flex showScrollbar fadeEdges>
            <div>
              {computed(() =>
                repos
                  .get()
                  .filter((e) => e && e.owner && e.repo)
                  .map((entry) => (
                    <RepoCard
                      owner={entry.owner}
                      repo={entry.repo}
                      githubToken={githubToken}
                    />
                  ))
              )}
            </div>
          </ct-vscroll>

          <ct-vstack slot="footer" gap="2" style={{ padding: "8px 12px" }}>
            <ct-hstack gap="2" align="end">
              <ct-vstack gap="1" style={{ flex: "1" }}>
                <label
                  style={{
                    fontSize: "11px",
                    color: "var(--ct-color-gray-500)",
                  }}
                >
                  GitHub Token
                </label>
                <ct-input
                  $value={githubToken}
                  placeholder="ghp_..."
                  type="password"
                />
              </ct-vstack>
            </ct-hstack>
            <ct-hstack gap="2" align="end">
              <ct-textarea
                $value={addText}
                placeholder="Add repos (one per line):&#10;owner/repo"
                rows={2}
                style={{ flex: "1" }}
              />
              <ct-button variant="primary" onClick={addFromInput}>
                Add
              </ct-button>
            </ct-hstack>
          </ct-vstack>
        </ct-screen>
      ),
      repos,
      githubToken,
      addRepos,
      removeRepo,
    };
  },
);
