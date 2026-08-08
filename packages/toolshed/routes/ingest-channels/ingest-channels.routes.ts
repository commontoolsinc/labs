import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";
import { MAX_TTL_DAYS } from "./ingest-channels.utils.ts";

// The CONTROL plane for ingest channels: mint, list, rotate, revoke.
//
// Mounted at its own prefix, deliberately NOT under `/api/ingest/*`:
//   1. `/api/ingest/*` carries `cors({ origin: "*", allowMethods: ["POST"] })`.
//      Inheriting that would make this a credentialed cross-origin POST surface,
//      against a written invariant of the first-party auth spec ("the protected
//      routes do not expose wildcard CORS").
//   2. `POST /api/ingest/channels` would collide with `POST /api/ingest/:id`.
//   3. Data plane and control plane should not share middleware.
// Keep the two prefixes separate LITERAL strings — a future `/api/ingest*`
// would silently merge them again.
//
// EVERY verb is POST, including list and revoke. Not aesthetics: the in-runtime
// signer is a hardcoded POST-only path allowlist
// (PROTECTED_TOOLSHED_FIRST_PARTY_ROUTES), so a GET or DELETE cannot be signed
// by an in-pattern caller at all. POST-only keeps a future shell/pattern client
// reachable.

const tags = ["Ingest Channels"];

export const BASE = "/api/ingest-channels";

const spaceField = z.string().describe(
  "The did:key of the space to write into. You must hold an explicit OWNER " +
    "grant on its ACL.",
);

// An idempotency key; see `claimMintRequest` for why a credential-minting route
// needs one when request proofs have no replay cache.
const requestIdField = z.string().describe(
  "A caller-generated random id. Replaying a request with an id already used " +
    "returns 409 and no secret.",
);

const channelSummary = z.object({
  id: z.string(),
  name: z.string(),
  space: z.string(),
  causePrefix: z.string(),
  installId: z.string(),
  sink: z.literal("journal"),
  createdAt: z.string(),
  enabled: z.boolean(),
  owner: z.string().optional(),
  expiresAt: z.string().optional(),
  revoked: z.object({ at: z.string(), by: z.string() }).optional(),
  revocations: z.array(z.object({ at: z.string(), by: z.string() })).optional(),
  lastSeenAt: z.string().nullable(),
  revision: z.number(),
});

const jsonError = {
  content: { "application/json": { schema: z.object({ error: z.string() }) } },
};

const commonResponses = {
  [HttpStatusCodes.BAD_REQUEST]: { ...jsonError, description: "Invalid input" },
  [HttpStatusCodes.UNAUTHORIZED]: {
    ...jsonError,
    description: "Missing or invalid first-party request proof",
  },
  // One indistinguishable denial covering: bad space DID, a space this
  // deployment does not host, no ACL, a malformed ACL, and simply not being an
  // owner. Splitting them would hand any keypair holder an existence oracle
  // over the deployment's whole space inventory.
  [HttpStatusCodes.FORBIDDEN]: {
    ...jsonError,
    description: "Not an owner of that space, or no such space",
  },
  [HttpStatusCodes.CONFLICT]: {
    ...jsonError,
    description:
      "Replayed requestId, or this deployment cannot write to the space",
  },
  [HttpStatusCodes.TOO_MANY_REQUESTS]: {
    ...jsonError,
    description: "Rate limited",
  },
  [HttpStatusCodes.BAD_GATEWAY]: {
    ...jsonError,
    description: "Storage failure",
  },
} as const;

/** The token is returned ONCE, here and on rotate, and never stored in clear. */
const mintResult = z.object({
  id: z.string(),
  url: z.string(),
  space: z.string(),
  causePrefix: z.string(),
  installId: z.string(),
  expiresAt: z.string().optional(),
  token: z.string().describe("Shown once. Hand it to the device."),
});

export const mint = createRoute({
  path: `${BASE}/mint`,
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            space: spaceField,
            installId: z.string().describe(
              "Stable per-device id. Also the cross-repo join key and the " +
                "provenance mark's audience.",
            ),
            causePrefix: z.string().optional(),
            name: z.string().optional(),
            ttlDays: z.number().int().positive().max(MAX_TTL_DAYS).optional(),
            requestId: requestIdField,
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: { "application/json": { schema: mintResult } },
      description: "Channel minted (or its token rotated in place)",
    },
    ...commonResponses,
  },
});

export const list = createRoute({
  path: `${BASE}/list`,
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            space: z.string().optional().describe("Filter to one space."),
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({ channels: z.array(channelSummary) }),
        },
      },
      description: "Channels this caller minted. Never includes secretHash.",
    },
    ...commonResponses,
  },
});

export const rotate = createRoute({
  path: `${BASE}/rotate`,
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            ttlDays: z.number().int().positive().max(MAX_TTL_DAYS).optional(),
            requestId: requestIdField,
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: { "application/json": { schema: mintResult } },
      description: "New token minted; the previous one stops working",
    },
    ...commonResponses,
  },
});

export const revoke = createRoute({
  path: `${BASE}/revoke`,
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            requestId: requestIdField,
            // REQUIRED, and the actual defence. The request id only makes a
            // revoke at-most-once-DELIVERED; it does nothing for one that is
            // captured and withheld, because an id that was never spent is
            // still live for the whole proof window. Naming the generation the
            // caller looked at is what stops a withheld revoke from landing on
            // a credential minted after it was signed. Read it from `list`.
            expectedRevision: z.number().int().nonnegative(),
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          // `revision` is the generation AFTER this write. Returned because
          // `revoke` requires the caller to name a current generation, and a
          // caller who has just revoked would otherwise have to go find it
          // again via a space-scoped list.
          schema: z.object({
            id: z.string(),
            revokedAt: z.string(),
            revision: z.number(),
          }),
        },
      },
      description:
        "Channel disabled; the registration is kept as an audit record",
    },
    ...commonResponses,
    // Overrides the shared 409: revoke has a cause the others do not, and it is
    // the one a caller is most likely to hit. Sending them to look for a
    // replayed requestId when they actually raced a rotate wastes the debugging
    // session the description exists to shorten.
    [HttpStatusCodes.CONFLICT]: {
      ...jsonError,
      description:
        "`expectedRevision` no longer matches the stored channel (list it " +
        "again and re-issue), replayed requestId, or this deployment cannot " +
        "write to the space",
    },
  },
});

export type MintRoute = typeof mint;
export type ListRoute = typeof list;
export type RotateRoute = typeof rotate;
export type RevokeRoute = typeof revoke;
