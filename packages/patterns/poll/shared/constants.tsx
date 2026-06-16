import { nonPrivateRandom, safeDateNow } from "commonfabric";

export const PLAYER_COLORS = [
  "#2f8a64",
  "#c2573a",
  "#3b4a6b",
  "#a33b35",
  "#b27722",
  "#7c3aed",
];

export const VOTE_SWATCH = {
  green: "#2f8a64",
  yellow: "#d4a82f",
  red: "#a33b35",
} as const;

export const trimmedName = (n: string | undefined) => (n ?? "").trim();

export const newOptionId = () =>
  `o_${safeDateNow().toString(36)}_${
    Math.floor(nonPrivateRandom() * 1e6).toString(36)
  }`;

export const colorForIndex = (i: number) =>
  PLAYER_COLORS[i % PLAYER_COLORS.length];

export const getInitials = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed.split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(
    0,
    2,
  );
};
