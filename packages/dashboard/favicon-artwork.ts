// Source artwork for raster generation and parity tests. Runtime modules serve
// only the generated PNGs and do not import this file.
import type { FaviconFace } from "./favicon-types.ts";

const FAVICON_COLORS: Record<FaviconFace, string> = {
  good: "#43c574",
  warn: "#e0a852",
  bad: "#e2504a",
  "bad-crying": "#e2504a",
};

const SMILE = "M11 19c2.8 2.6 7.2 2.6 10 0";
const FAVICON_MOUTHS: Record<FaviconFace, string> = {
  good: SMILE,
  warn: "M11 20h10",
  bad: "M11 21c2.8-2.6 7.2-2.6 10 0",
  "bad-crying": "M10.5 22c3-4 8-4 11 0",
};

const FAVICON_DETAILS: Record<FaviconFace, string> = {
  good: "",
  warn: "",
  bad: "",
  "bad-crying": `
    <path d="M9.5 11.2l3.5 1M22.5 11.2l-3.5 1" fill="none" stroke="#16181d" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M12 16.5c-1 1.3-1.4 2.2-1.4 3a1.4 1.4 0 0 0 2.8 0c0-.8-.4-1.7-1.4-3Z" fill="#9edcff"/>`,
};

export function faviconSvg(status: FaviconFace): string {
  const color = FAVICON_COLORS[status];
  const mouth = FAVICON_MOUTHS[status];
  const details = FAVICON_DETAILS[status];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <rect x="1" y="1" width="30" height="30" rx="9" fill="#16181d" stroke="#23262d" stroke-width="2"/>
    <rect x="5" y="5" width="22" height="22" rx="7" fill="${color}"/>
    <circle cx="12" cy="14" r="1.7" fill="#16181d"/>
    <circle cx="20" cy="14" r="1.7" fill="#16181d"/>
    ${details}
    <path d="${mouth}" fill="none" stroke="#16181d" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;
}
