import { createRoute } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { z } from "zod";

// The pattern-lifecycle verbs as server calls
// (docs/features/server-pattern-lifecycle.md): a client sends the source
// it resolved, and the space's serving runtime compiles, materializes, and
// commits. Every verb is a POST at its own prefix, the shape the first-party
// request proof signs and the ingest control plane established.

const tags = ["Pattern Lifecycle"];

export const BASE = "/api/pattern-lifecycle";

/** The largest request body a verb accepts; a program's files ride inline. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

const spaceField = z.string().describe(
  "The did:key of the space to act in. You must hold a WRITE or OWNER grant " +
    "on its ACL.",
);

const programSchema = z.object({
  main: z.string().describe("The entry file's name within `files`."),
  mainExport: z.string().optional().describe(
    'The entry file\'s export holding the pattern; "default" when absent.',
  ),
  files: z.array(z.object({ name: z.string(), contents: z.string() })),
  sourceRoots: z.array(z.string()).optional().describe(
    "Entry points retained and compiled without being run, such as tests.",
  ),
  dataFiles: z.array(z.string()).optional().describe(
    "Names of entries in `files` that carry data rather than code.",
  ),
}).describe(
  "A program as the client resolved it: every file it needs, by name.",
);

const patternRefSchema = z.object({
  identity: z.string(),
  symbol: z.string(),
}).describe(
  "A content-addressed pattern pointer the space already holds — the " +
    "result of an earlier upload.",
);

const sourceFields = {
  program: programSchema.optional(),
  pattern: patternRefSchema.optional(),
};

const jsonError = {
  content: {
    "application/json": {
      schema: z.object({
        error: z.string(),
        code: z.string().describe("A stable name for the refusal."),
      }),
    },
  },
};

const commonResponses = {
  [HttpStatusCodes.BAD_REQUEST]: { ...jsonError, description: "Invalid input" },
  [HttpStatusCodes.UNAUTHORIZED]: {
    ...jsonError,
    description: "Missing or invalid first-party request proof",
  },
  [HttpStatusCodes.FORBIDDEN]: {
    ...jsonError,
    description: "Not a writer of that space, or no such space",
  },
  [HttpStatusCodes.NOT_FOUND]: {
    ...jsonError,
    description: "The named pattern is not in the space",
  },
  [HttpStatusCodes.CONFLICT]: {
    ...jsonError,
    description: "The requested slug is taken",
  },
  [HttpStatusCodes.REQUEST_TOO_LONG]: {
    ...jsonError,
    description: "Request body exceeds the limit (checked before auth)",
  },
  [HttpStatusCodes.UNPROCESSABLE_ENTITY]: {
    ...jsonError,
    description:
      "Body failed schema validation, the program did not compile, or " +
      "setup refused it",
  },
  [HttpStatusCodes.TOO_MANY_REQUESTS]: {
    ...jsonError,
    description: "Rate limited",
  },
  [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
    ...jsonError,
    description: "The serving side failed",
  },
  [HttpStatusCodes.SERVICE_UNAVAILABLE]: {
    ...jsonError,
    description:
      "This deployment does not run the serving loop, or does not serve " +
      "the space",
  },
} as const;

export const upload = createRoute({
  path: `${BASE}/upload`,
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ space: spaceField, program: programSchema }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": { schema: z.object({ pattern: patternRefSchema }) },
      },
      description: "The program compiled and its closure is in the space",
    },
    ...commonResponses,
  },
});

export const instantiate = createRoute({
  path: `${BASE}/instantiate`,
  method: "post",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            space: spaceField,
            ...sourceFields,
            argument: z.record(z.string(), z.unknown()).optional().describe(
              "The new piece's argument; the pattern's defaults when absent.",
            ),
            repository: z.string().optional().describe(
              "Repository locator stored with the piece's source.",
            ),
            slug: z.string().optional().describe(
              "A name for the piece, claimed in the creation transaction; " +
                "a name already taken refuses the whole creation.",
            ),
            force: z.boolean().optional().describe(
              "Take `slug` even when it already names something.",
            ),
            register: z.boolean().optional().describe(
              "Add the piece to the space root's registry.",
            ),
          }),
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: {
        "application/json": {
          schema: z.object({
            pieceId: z.string(),
            pattern: patternRefSchema,
            slug: z.string().optional(),
          }),
        },
      },
      description: "The piece exists in the space",
    },
    ...commonResponses,
  },
});

export type UploadRoute = typeof upload;
export type InstantiateRoute = typeof instantiate;
