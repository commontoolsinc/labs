import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import { Controls, SelectControl } from "../ui/controls/index.ts";

// Self-contained avatar image (data-URI SVG) — no network / CSP needed.
const svgAvatar = (rgb: string, label: string): string =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">` +
      `<rect width="96" height="96" rx="48" fill="${rgb}"/>` +
      `<text x="48" y="50" font-family="sans-serif" font-size="40" ` +
      `font-weight="600" fill="white" text-anchor="middle" ` +
      `dominant-baseline="central">${label}</text></svg>`,
  );

// A profile cell, as presented to <cf-profile-badge $profile={...} />. The badge
// reads the cell's [NAME] (person's name under the multi-profile model) and
// falls back to `name`, plus `avatar`. `bio` + `elements` (pinned pieces) feed
// the hover/focus tooltip (CT-1648); items only need a `title` for the count.
type ProfileValue = {
  [NAME]: string;
  name: string;
  avatar: string;
  bio?: string;
  elements?: Array<{ title: string }>;
};

const makeProfile = (
  display: string,
  avatar: string,
  extra: { bio?: string; elements?: Array<{ title: string }> } = {},
) =>
  new Writable<ProfileValue>({
    [NAME]: display,
    name: display,
    avatar,
    ...extra,
  });

const sizeItems = [
  { label: "xs", value: "xs" },
  { label: "sm", value: "sm" },
  { label: "md", value: "md" },
  { label: "lg", value: "lg" },
  { label: "xl", value: "xl" },
];

const sectionLabel = {
  fontSize: "0.75rem",
  fontWeight: "600",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "#6b7280",
  margin: "0 0 8px",
};

// Fixed-width monospace tag so the three variant rows line up.
const variantTag = {
  fontFamily: "monospace",
  fontSize: "0.75rem",
  color: "#9ca3af",
  width: "3.5rem",
  flex: "0 0 auto",
};

const variantRow = {
  display: "flex",
  gap: "12px",
  alignItems: "center",
  flexWrap: "wrap",
};

// deno-lint-ignore no-empty-interface
interface ProfileBadgeStoryInput {}
export interface ProfileBadgeStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ProfileBadgeStoryInput, ProfileBadgeStoryOutput>(() => {
  // Three profiles exercising each avatar render path: image, emoji, initials —
  // and each tooltip state (CT-1648): bio + pins, bio only, and none.
  const ada = makeProfile("Ada Lovelace", svgAvatar("rgb(99,102,241)", "AL"), {
    bio:
      "Mathematician & writer; first to see that a computing engine could go beyond pure calculation.",
    elements: [
      { title: "Analytical Engine notes" },
      { title: "Bernoulli generator" },
      { title: "Note G" },
    ],
  });
  const grace = makeProfile("Grace Hopper", "🦊", {
    bio: "Rear admiral and compiler pioneer; popularized the term “debugging.”",
  });
  const alan = makeProfile("Alan Turing", "");

  const size = new Writable<"xs" | "sm" | "md" | "lg" | "xl">("md");

  return {
    [NAME]: "cf-profile-badge Story",
    [UI]: (
      <div
        style={{
          padding: "1.5rem",
          display: "flex",
          flexDirection: "column",
          gap: "28px",
        }}
      >
        <div>
          <p style={sectionLabel}>
            Trusted identity — avatar + name from a profile cell
          </p>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              alignItems: "flex-start",
            }}
          >
            <cf-profile-badge $profile={ada} size={size} noNavigate />
            <cf-profile-badge $profile={grace} size={size} noNavigate />
            <cf-profile-badge $profile={alan} size={size} noNavigate />
          </div>
        </div>

        <div>
          <p style={sectionLabel}>
            Variants (CT-1761) — full · chip · circle · hero
          </p>
          <div
            style={{ display: "flex", flexDirection: "column", gap: "16px" }}
          >
            <div style={variantRow}>
              <span style={variantTag}>full</span>
              <cf-profile-badge $profile={ada} variant="full" noNavigate />
              <cf-profile-badge $profile={grace} variant="full" noNavigate />
              <cf-profile-badge $profile={alan} variant="full" noNavigate />
            </div>
            <div style={variantRow}>
              <span style={variantTag}>chip</span>
              <cf-profile-badge $profile={ada} variant="chip" noNavigate />
              <cf-profile-badge $profile={grace} variant="chip" noNavigate />
              <cf-profile-badge $profile={alan} variant="chip" noNavigate />
            </div>
            <div style={variantRow}>
              <span style={variantTag}>circle</span>
              <cf-profile-badge $profile={ada} variant="circle" noNavigate />
              <cf-profile-badge $profile={grace} variant="circle" noNavigate />
              <cf-profile-badge $profile={alan} variant="circle" noNavigate />
            </div>
            <div style={variantRow}>
              <span style={variantTag}>hero</span>
              <cf-profile-badge $profile={ada} variant="hero" noNavigate />
              <cf-profile-badge $profile={grace} variant="hero" noNavigate />
            </div>
          </div>
        </div>

        <span
          style={{ fontSize: "0.875rem", color: "#6b7280", maxWidth: "40ch" }}
        >
          Avatar paths shown: image (Ada), emoji (Grace), initials (Alan). The
          verification signal is the generative seal — a DID-derived aura ring
          plus a cursor-reactive glint (there is no shield icon). It only
          renders for a runtime-attested profile (a “represents-principal” CFC
          label), which this story can’t mint, so these badges stay in the plain
          “presented” state. Hover or focus a badge to see its tooltip
          (CT-1648): Ada has a bio + 3 pinned pieces, Grace has a bio only, and
          Alan — with neither — shows no tooltip. The variants (CT-1761) all
          carry the same seal: <code>full</code> is an avatar + name pill;{" "}
          <code>chip</code> is a compact name + seal dot for inline use;{" "}
          <code>circle</code>{" "}
          is avatar + seal ring only (name on hover / for screen readers);
          <code>hero</code>{" "}
          is a large avatar-over-name for a profile page header.
        </span>
      </div>
    ),
    controls: (
      <Controls>
        <SelectControl
          label="size"
          description="Avatar size"
          defaultValue="md"
          value={size}
          items={sizeItems}
        />
      </Controls>
    ),
  };
});
