/**
 * Shared UI helpers for OAuth auth patterns.
 */
import type { AuthStatus } from "./auth-types.ts";

/** Status indicator colors for preview UI */
export const STATUS_CONFIG: Record<
  AuthStatus,
  { dot: string; bg: string }
> = {
  ready: { dot: "#22c55e", bg: "#f0fdf4" },
  warning: { dot: "#eab308", bg: "#fefce8" },
  expired: { dot: "#ef4444", bg: "#fef2f2" },
  "needs-login": { dot: "#9ca3af", bg: "#f9fafb" },
  "missing-scopes": { dot: "#f97316", bg: "#fff7ed" },
};

/**
 * Get a compact scope summary string from a list of scope strings.
 * Uses a lookup map to convert raw scope strings to short display names.
 */
export function getScopeSummary(
  scopes: string[],
  scopeShortNames: Record<string, string>,
): string {
  const names = new Set<string>();
  for (const scope of scopes) {
    const name = scopeShortNames[scope];
    if (name) names.add(name);
  }
  const arr = Array.from(names);
  if (arr.length === 0) return "";
  if (arr.length <= 3) return arr.join(", ");
  return `${arr.slice(0, 2).join(", ")} +${arr.length - 2} more`;
}

/**
 * Get a compact scope summary from selected scope flags.
 * Uses a lookup map to convert scope keys to short display names.
 */
export function getSelectedScopeSummary(
  selectedScopes: Record<string, boolean>,
  scopeKeyShortNames: Record<string, string>,
): string {
  const names = new Set<string>();
  for (const [key, enabled] of Object.entries(selectedScopes)) {
    if (enabled) {
      const name = scopeKeyShortNames[key];
      if (name) names.add(name);
    }
  }
  const arr = Array.from(names);
  if (arr.length === 0) return "";
  if (arr.length <= 3) return arr.join(", ");
  return `${arr.slice(0, 2).join(", ")} +${arr.length - 2} more`;
}

/**
 * Format time remaining in a human-readable way.
 */
export function formatTimeRemaining(ms: number | null): string {
  if (ms === null) return "";
  if (ms <= 0) return "Expired";

  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMins = minutes % 60;
    return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
  }
  if (minutes > 0) return `${minutes} min`;
  return "< 1 min";
}

/**
 * Format token expiry for auth pattern UI (slightly different format).
 * Returns null if no expiresAt, "Expired" if expired, or "Xh Ym" / "Xm".
 */
export function formatTokenExpiry(
  expiresAt: number,
  currentTime: number,
): string | null {
  if (!expiresAt || expiresAt === 0) return null;
  const remaining = expiresAt - currentTime;
  if (remaining <= 0) return "Expired";

  const minutes = Math.floor(remaining / (60 * 1000));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
