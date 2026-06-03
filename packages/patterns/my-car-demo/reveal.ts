// Pure reveal-handshake state machine (Phase 6). The admin can REQUEST that an
// owner reveal a claim's private `ownerNote`; the owner approves or declines.
// This module is the deterministic, testable core of that handshake.
//
// What is OUT of scope here (gated on runtime/CT-1658, see DESIGN §7): the actual
// CFC confidentiality ENFORCEMENT — `ownerNote: Confidential<string, …>` being
// structurally unreadable by the admin until approval, and the admin-visible
// `ResolvedIdentity = ProjectionOf<VehicleClaim, ["claimant","vehicle"]>` that
// excludes the note. Those are compile-time CFC brands whose enforcement needs a
// running dual-runtime; this state machine models the request/approve/decline
// lifecycle that drives them.

export type RevealStatus = "pending" | "approved" | "declined";

export interface RevealRequest {
  requestedBy: string; // admin DID (the requester)
  claimId: string; // identifies which claim's ownerNote is requested
  status: RevealStatus;
}

const sameRequest = (
  request: RevealRequest,
  requestedBy: string,
  claimId: string,
): boolean =>
  request.requestedBy === requestedBy && request.claimId === claimId;

// Admin asks. Idempotent: a second request for the same (admin, claim) does not
// duplicate or reset an existing one.
export const requestReveal = (
  requests: readonly RevealRequest[],
  requestedBy: string,
  claimId: string,
): RevealRequest[] => {
  if (requests.some((request) => sameRequest(request, requestedBy, claimId))) {
    return [...requests];
  }
  return [...requests, { requestedBy, claimId, status: "pending" }];
};

// Owner approves / declines. Only the matching request transitions.
export const setRevealStatus = (
  requests: readonly RevealRequest[],
  requestedBy: string,
  claimId: string,
  status: RevealStatus,
): RevealRequest[] =>
  requests.map((request) =>
    sameRequest(request, requestedBy, claimId)
      ? { ...request, status }
      : request
  );

// The admin may read the note only when the owner has approved this request.
export const isRevealed = (
  requests: readonly RevealRequest[],
  requestedBy: string,
  claimId: string,
): boolean =>
  requests.some((request) =>
    sameRequest(request, requestedBy, claimId) && request.status === "approved"
  );
