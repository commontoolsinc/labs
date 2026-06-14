export const HARNESS_BROWSER_ACCESS_LEASE_TYPE =
  "cf-harness.chat.browser-access-lease" as const;

export const HARNESS_BROWSER_ACCESS_PROFILE_MODES = [
  "persistent",
  "transient",
] as const;

export type HarnessBrowserAccessProfileMode =
  typeof HARNESS_BROWSER_ACCESS_PROFILE_MODES[number];

export const HARNESS_BROWSER_ACCESS_ACCOUNT_ACCESS = [
  "available",
  "none",
] as const;

export type HarnessBrowserAccessAccountAccess =
  typeof HARNESS_BROWSER_ACCESS_ACCOUNT_ACCESS[number];

export interface HarnessBrowserAccessLease {
  type: typeof HARNESS_BROWSER_ACCESS_LEASE_TYPE;
  leaseId: string;
  cdpUrl: string;
  owner?: string;
  expiresAt?: string;
  profileMode?: HarnessBrowserAccessProfileMode;
  accountAccess?: HarnessBrowserAccessAccountAccess;
}

export const parseBrowserAccessExpiresAt = (
  expiresAt: string,
): Date | undefined => {
  const timestampMs = Date.parse(expiresAt);
  return Number.isFinite(timestampMs) ? new Date(timestampMs) : undefined;
};

export const validateBrowserAccessLeaseFreshness = (
  expiresAt: string | undefined,
  options: { now?: Date } = {},
): string | undefined => {
  if (expiresAt === undefined || expiresAt.trim() === "") {
    return undefined;
  }
  const expiresAtDate = parseBrowserAccessExpiresAt(expiresAt);
  if (expiresAtDate === undefined) {
    return "Browser Access lease expiry is invalid";
  }
  const now = options.now ?? new Date();
  if (expiresAtDate.getTime() <= now.getTime()) {
    return "Browser Access lease has expired";
  }
  return undefined;
};
