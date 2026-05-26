export const HARNESS_BROWSER_ACCESS_LEASE_TYPE =
  "cf-harness.chat.browser-access-lease" as const;

export interface HarnessBrowserAccessLease {
  type: typeof HARNESS_BROWSER_ACCESS_LEASE_TYPE;
  leaseId: string;
  cdpUrl: string;
  owner?: string;
  expiresAt?: string;
}
