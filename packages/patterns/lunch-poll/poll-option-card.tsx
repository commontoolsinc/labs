import {
  computed,
  Default,
  fetchData,
  generateText,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import GeneratedArt from "./generated-art.tsx";
import type {
  CastVoteEvent,
  LogVisitEvent,
  Option,
  RemoveOptionEvent,
  SetOptionImageEvent,
  SetOptionUrlEvent,
  Vote,
  VoteColor,
} from "./main.tsx";

type LinkTargetCell = Writable<string | null>;
type NameCell = Writable<string | Default<"">>;

interface WebSearchResponse {
  results?: Array<{ title?: string; url?: string; description?: string }>;
}

const trimmedName = (n: string | undefined) => (n ?? "").trim();

const httpsOrNull = (candidate: string): string | null => {
  try {
    const u = new URL(candidate);
    return (u.protocol === "http:" || u.protocol === "https:")
      ? u.toString()
      : null;
  } catch {
    return null;
  }
};

const safeHttpUrl = (raw: string | undefined): string => {
  const s = (raw ?? "").trim();
  if (!s) return "";
  return httpsOrNull(s) ?? httpsOrNull(`https://${s}`) ?? "";
};

const safeImageUrl = (raw: string | undefined): string => {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (s.startsWith("data:image/")) return s;
  return safeHttpUrl(s);
};

const homePageLookupUrlFor = (
  isAdmin: boolean,
  _refresh: number,
  storedUrl: string | undefined,
  overrideUrl: string | undefined,
  endpoint: string,
): string =>
  isAdmin && !trimmedName(storedUrl) && !trimmedName(overrideUrl)
    ? endpoint
    : "";

const homePageVerifierSystem =
  "You verify restaurant website search results. Choose the restaurant's own " +
  "official website only when it is clear from the candidate URL, title, and " +
  "description. Reject directories, review sites, delivery apps, reservation " +
  "sites, social media, maps, unrelated restaurants, and similarly named " +
  "businesses. Answer with exactly one candidate number, or NONE.";

const homePageVerifierPrompt = (
  title: string,
  city: string,
  refresh: number,
  candidates: WebSearchResponse["results"],
): string => {
  const rows = (candidates ?? [])
    .map((candidate, index) =>
      typeof candidate?.url === "string" && candidate.url.length > 0
        ? (
          `${index + 1}. URL: ${candidate.url}\n` +
          `   Title: ${candidate.title ?? ""}\n` +
          `   Description: ${(candidate.description ?? "").slice(0, 300)}`
        )
        : ""
    )
    .filter((row) => row !== "");
  if (rows.length === 0) return "";
  return `Restaurant: ${title}\nCity: ${city}\nRefresh: ${refresh}\n\nCandidates:\n${
    rows.join("\n")
  }\n\nReturn only the candidate number, or NONE.`;
};

function toHomepage(url: string): string {
  try {
    return new URL(url).origin + "/";
  } catch {
    return url;
  }
}

const myVoteFor = (
  votes: readonly Vote[],
  me: string,
  optionId: string,
): VoteColor | undefined => {
  if (!me) return undefined;
  return votes.find(
    (v) => v.voterName === me && v.optionId === optionId,
  )?.voteType;
};

export interface PollOptionCardInput {
  option: Option;
  rank: number;
  me: string;
  isJoined: boolean;
  isAdmin: boolean;
  votes: readonly Vote[];
  cityLabel: string;
  searchEndpoint: string;
  homePageRefresh: number;
  linkEditTarget: LinkTargetCell;
  linkDraft: NameCell;
  removeConfirmTarget: LinkTargetCell;
  castVote: Stream<CastVoteEvent>;
  removeOption: Stream<RemoveOptionEvent>;
  logVisit: Stream<LogVisitEvent>;
  setOptionUrl: Stream<SetOptionUrlEvent>;
  setOptionHomePageUrl: Stream<SetOptionUrlEvent>;
  setOptionImage: Stream<SetOptionImageEvent>;
}

export interface PollOptionCardOutput {
  [NAME]: string;
  [UI]: VNode;
  artSyncState: string;
  homePageUrl: string;
}

export default pattern<PollOptionCardInput, PollOptionCardOutput>(
  (
    {
      option,
      rank,
      me,
      isJoined,
      isAdmin,
      votes,
      cityLabel,
      searchEndpoint,
      homePageRefresh,
      linkEditTarget,
      linkDraft,
      removeConfirmTarget,
      castVote,
      removeOption,
      logVisit,
      setOptionUrl,
      setOptionHomePageUrl,
      setOptionImage,
    },
  ) => {
    const oid = option.id;
    const optionTitle = option.title;
    const myVote = computed(() => myVoteFor(votes, me, oid));
    const isRemoveConfirm = computed(() => removeConfirmTarget.get() === oid);
    const refresh = computed(() => Number(homePageRefresh ?? 0));
    const generatedArt = GeneratedArt({
      prompt: option.title,
      sourceUrl: option.imageUrl,
      shouldGenerate: isAdmin,
    });

    // Host persists the generated image returned by the image route as a data
    // URL. Other viewers render the stored value without running image-gen.
    const artSyncState = computed(() => {
      if (safeImageUrl(option.imageUrl)) return "stored";
      if (!isAdmin) return "";
      const url = safeImageUrl(generatedArt.url);
      if (url) {
        setOptionImage.send({
          optionId: oid,
          imageUrl: url,
        });
        return "stored";
      }
      return generatedArt.fetchState;
    });

    const homePageSearch = fetchData<WebSearchResponse>({
      url: computed(() =>
        homePageLookupUrlFor(
          isAdmin,
          refresh,
          option.homePageUrl,
          option.homePageUrlOverride,
          searchEndpoint,
        )
      ),
      mode: "json",
      options: {
        method: "POST",
        mutexTimeoutMs: 30_000,
        headers: computed(() => ({
          "Content-Type": "application/json",
          "X-Lunch-Poll-Refresh": String(refresh),
        })),
        body: computed(() => ({
          query:
            `official website of the restaurant "${option.title}" in ${cityLabel}`,
          max_results: 4,
        })),
      },
    });

    const homePageVerifier = generateText({
      system: homePageVerifierSystem,
      prompt: computed(() => {
        if (
          !homePageLookupUrlFor(
            isAdmin,
            refresh,
            option.homePageUrl,
            option.homePageUrlOverride,
            searchEndpoint,
          )
        ) return "";
        if (homePageSearch.pending) return "";
        return homePageVerifierPrompt(
          option.title,
          cityLabel,
          refresh,
          homePageSearch.result?.results,
        );
      }),
    });

    const fetchedHomePageUrl = computed(() => {
      if (
        !homePageLookupUrlFor(
          isAdmin,
          refresh,
          option.homePageUrl,
          option.homePageUrlOverride,
          searchEndpoint,
        )
      ) return "";
      if (homePageSearch.pending || homePageVerifier.pending) {
        return "";
      }
      const choice = Number(trimmedName(homePageVerifier.result));
      const url = Number.isInteger(choice) && choice > 0
        ? homePageSearch.result?.results?.[choice - 1]?.url
        : "";
      return typeof url === "string" && url ? toHomepage(url) : "";
    });

    const displayHomePageUrl = computed(() => {
      const stored = trimmedName(option.homePageUrl);
      if (stored) return stored;
      const fetched = fetchedHomePageUrl;
      if (fetched) {
        setOptionHomePageUrl.send({
          optionId: oid,
          url: fetched,
        });
        return fetched;
      }
      return "";
    });

    const homeUrl = computed(() => {
      const o = trimmedName(option.homePageUrlOverride);
      if (o) return o;
      const stored = trimmedName(option.homePageUrl);
      if (stored) return stored;
      return `https://www.google.com/maps/search/?api=1&query=${
        encodeURIComponent(`${option.title} ${cityLabel}`)
      }`;
    });

    const isEditingLink = computed(() => linkEditTarget.get() === option.id);
    const homeLabel = computed(() => {
      if (trimmedName(option.homePageUrlOverride)) {
        return "🔗 Website (edited)";
      }
      return trimmedName(option.homePageUrl) ? "🔗 Website" : "🔎 Find on Maps";
    });

    return {
      [NAME]: optionTitle,
      [UI]: (
        <div
          style={{
            marginBottom: "10px",
            padding: "10px 12px",
            border: "1px solid #e5e7eb",
            borderRadius: "8px",
            backgroundColor: "white",
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}
          data-art-sync={artSyncState}
          data-homepage-sync={displayHomePageUrl}
        >
          {/* Pen-and-ink cuisine illustration (~1in square). */}
          {generatedArt}
          <span
            style={{
              minWidth: "28px",
              height: "28px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "9999px",
              backgroundColor: "#f3f4f6",
              color: "#374151",
              fontSize: "12px",
              fontWeight: 700,
            }}
          >
            #{rank}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontWeight: 600,
                fontSize: "14px",
                color: "#111827",
              }}
            >
              {optionTitle}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: "8px",
                marginTop: "2px",
                flexWrap: "wrap",
              }}
            >
              <a
                href={homeUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: "11px",
                  color: "#2f6f4e",
                  textDecoration: "underline",
                }}
              >
                {homeLabel}
              </a>
              {isJoined
                ? (
                  <button
                    type="button"
                    aria-label="Edit homepage link"
                    title="Edit link"
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "#9ca3af",
                      cursor: "pointer",
                      fontSize: "11px",
                      padding: 0,
                    }}
                    onClick={() => linkEditTarget.set(option.id)}
                  >
                    ✎ edit
                  </button>
                )
                : null}
            </div>
            {isEditingLink
              ? (
                <div
                  style={{
                    display: "flex",
                    gap: "6px",
                    alignItems: "center",
                    marginTop: "4px",
                    flexWrap: "wrap",
                  }}
                >
                  <cf-input
                    $value={linkDraft}
                    placeholder="Paste a homepage URL…"
                    aria-label="Homepage URL"
                    timing-strategy="immediate"
                    style="flex:1; min-width:160px;"
                  />
                  <cf-button
                    size="sm"
                    variant="primary"
                    onClick={() =>
                      setOptionUrl.send({
                        optionId: option.id,
                      })}
                  >
                    Save
                  </cf-button>
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setOptionUrl.send({
                        optionId: option.id,
                        url: "",
                      })}
                  >
                    Clear
                  </cf-button>
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={() => linkEditTarget.set(null)}
                  >
                    Cancel
                  </cf-button>
                </div>
              )
              : null}
            <div
              style={{
                fontSize: "11px",
                color: "#6b7280",
                display: "flex",
                gap: "6px",
                alignItems: "baseline",
              }}
            >
              <span>added by {option.addedByName}</span>
              {isAdmin
                ? (
                  <button
                    type="button"
                    aria-label="Remove option (host)"
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      color: "#9ca3af",
                      fontSize: "11px",
                      textDecoration: "underline",
                      cursor: "pointer",
                    }}
                    onClick={() => removeConfirmTarget.set(oid)}
                  >
                    · remove
                  </button>
                )
                : null}
              {isAdmin
                ? (
                  <button
                    type="button"
                    aria-label="Log that we went here (host)"
                    style={{
                      background: "#eaf6ef",
                      border: "1px solid #b7e0c8",
                      borderRadius: "9999px",
                      padding: "2px 10px",
                      color: "#2f6f4e",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                    onClick={() => logVisit.send({ optionId: oid })}
                  >
                    ✓ we went here
                  </button>
                )
                : null}
            </div>
            {isRemoveConfirm
              ? (
                <div
                  style={{
                    marginTop: "8px",
                    padding: "8px 10px",
                    backgroundColor: "#fef2f2",
                    border: "1px solid #fecaca",
                    borderRadius: "6px",
                    fontSize: "12px",
                    color: "#991b1b",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    flexWrap: "wrap",
                  }}
                >
                  <span>
                    Remove "{optionTitle}" and discard its votes?
                  </span>
                  <cf-button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      removeOption.send({ optionId: oid });
                      removeConfirmTarget.set(null);
                    }}
                  >
                    Yes, remove
                  </cf-button>
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeConfirmTarget.set(null)}
                  >
                    Cancel
                  </cf-button>
                </div>
              )
              : null}
          </div>
          {isJoined
            ? (
              <div
                style={{
                  display: "flex",
                  gap: "6px",
                  alignItems: "center",
                }}
              >
                <cf-button
                  aria-label={myVote === "green"
                    ? "Clear my green vote"
                    : "Love it"}
                  style={myVote === "green"
                    ? "background-color: #22c55e; color: white; font-weight: bold; border: 2px solid #16a34a;"
                    : myVote
                    ? "opacity: 0.4;"
                    : ""}
                  onClick={() =>
                    castVote.send({
                      optionId: oid,
                      voteType: "green",
                    })}
                >
                  🟢
                </cf-button>
                <cf-button
                  aria-label={myVote === "yellow"
                    ? "Clear my yellow vote"
                    : "Okay with it"}
                  style={myVote === "yellow"
                    ? "background-color: #eab308; color: white; font-weight: bold; border: 2px solid #ca8a04;"
                    : myVote
                    ? "opacity: 0.4;"
                    : ""}
                  onClick={() =>
                    castVote.send({
                      optionId: oid,
                      voteType: "yellow",
                    })}
                >
                  🟡
                </cf-button>
                <cf-button
                  aria-label={myVote === "red" ? "Clear my red vote" : "Veto"}
                  style={myVote === "red"
                    ? "background-color: #ef4444; color: white; font-weight: bold; border: 2px solid #dc2626;"
                    : myVote
                    ? "opacity: 0.4;"
                    : ""}
                  onClick={() =>
                    castVote.send({
                      optionId: oid,
                      voteType: "red",
                    })}
                >
                  🔴
                </cf-button>
              </div>
            )
            : null}
        </div>
      ),
      artSyncState,
      homePageUrl: displayHomePageUrl,
    };
  },
);
