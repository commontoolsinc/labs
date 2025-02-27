import { z } from "zod";
import { createRoute } from "@hono/zod-openapi";
import { jsonContent } from "stoker/openapi/helpers";
import * as HttpStatusCodes from "stoker/http-status-codes";

export const tags = ["Memory Storage"];

export const Null = z.literal(null);
export const Unit = z.object({});
export const Meta = z.record(z.string(), z.string()).describe(
  "Arbitrary metadata",
);
export const The = z.string().describe(
  "Type of the fact usually formatted as media type",
);
export const Of = z.string().describe(
  "Unique identifier for the mutable entity",
);

export const DID = z
  .string()
  .startsWith("did:")
  .refine((did): did is `did:${string}:${string}` => true);

export const Space = z.union([z.string(), DID]).describe(
  "Unique did:key identifier of the memory space",
);
export const Principal = z.union([z.string(), DID]).describe(
  "Unique DID identifier of the issuing principal",
);

export const Cause = z.string().describe(
  "Merkle reference to the previous state of the entity",
);
export const Retract = z
  .object({
    is: z.literal(undefined).optional().describe(
      "Retraction has no 'is' field",
    ),
  })
  .describe("Retracts fact");
export const Claim = z.literal(true).describe("Expects fact");

export const JSONValue = z.any().describe("Arbitrary JSON value");
export const Assert = z
  .object({ is: JSONValue })
  .describe("Asserts new fact replacing the old one");
export const Change = Claim.or(Retract)
  .or(Assert)
  .describe("Describes expected state and how it should change");
export const Changes = z
  .record(Of, z.record(The, z.record(Cause, Change)))
  .describe("Describes changes to be transacted");

export const Reference = z
  .object({
    "/": z.any(),
  })
  .describe("Merkle reference");

export const Fact = z.object({
  the: The,
  of: Of,
  is: JSONValue.optional(),
  cause: Reference,
});

export const Since = z.number().int().describe(
  "Sequence number of the transaction",
);
export const Selector = z.record(
  Of,
  z.record(
    The,
    z.record(
      Cause,
      z.object({
        is: Unit.optional().describe(
          "If omitted will includes retracted facts",
        ),
      }),
    ),
  ),
);

export const Transaction = z.object({
  cmd: z.literal("/memory/transact"),
  iss: Principal,
  sub: Space,
  args: z.object({ changes: Changes }),
  meta: Meta.optional(),
});

export const Query = z.object({
  cmd: z.literal("/memory/query"),
  iss: Principal,
  sub: Space,
  args: z.object({
    select: Selector,
    since: z.number().optional(),
  }),
  meta: Meta.optional(),
});

export const CommitData = z.object({
  since: z.number().int(),
  transaction: Transaction,
});
export const Commit = z.record(
  Space,
  z.object({
    "application/commit+json": z.record(Cause, z.object({ is: CommitData })),
  }),
);

export const Conflict = z.object({
  space: Space,
  the: The,
  of: Of,
  expected: Reference.or(Null).describe(`Expected state in the memory space`),
  actual: Fact.or(Null).describe("Actual state in the memory space"),
});

export const ConflictError = z.object({
  name: z.literal("ConflictError"),
  transaction: Transaction.describe("Transaction that caused an error"),
  conflict: Conflict.describe("Conflicting fact in the memory space"),
});

export const SystemError = z.object({
  name: z.string(),
  message: z.string(),
  code: z.number().optional(),
  stack: z.string().optional(),
});

export const TransactionError = z.object({
  name: z.literal("TransactionError"),
  message: z.string(),
  cause: SystemError,
  transaction: Transaction.describe("Transaction that caused an error"),
});

export const ConnectionError = z
  .object({
    name: z.literal("ConnectionError"),
    cause: SystemError,
    address: z.string(),
  })
  .describe("Error connecting with a memory space");

export const QueryError = z.object({
  name: z.literal("QueryError"),
  cause: SystemError,
  selector: Selector,
});

const ok = <T extends z.ZodTypeAny>(ok: T) => z.object({ ok });
const error = <T extends z.ZodTypeAny>(error: T) => z.object({ error });

export const transact = createRoute({
  method: "patch",
  path: "/api/storage/memory",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: Transaction,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(ok(Commit), "Successful transaction"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      error(ConflictError),
      "Conflict occurred",
    ),
    [HttpStatusCodes.SERVICE_UNAVAILABLE]: jsonContent(
      error(ConnectionError.or(TransactionError)),
      "Memory service is unable to process transaction",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      error(TransactionError.or(SystemError)),
      "Memory service error",
    ),
  },
});

export const query = createRoute({
  method: "post",
  path: "/api/storage/memory",
  tags,
  request: {
    body: {
      content: {
        "application/json": {
          schema: Query,
        },
      },
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        ok: z.record(
          z.string(),
          z.union([
            z.array(
              z.object({
                the: z.any(),
                of: z.any(),
                is: z.any(),
              }),
            ),
            z.object({
              the: z.any(),
              of: z.any(),
              is: z.any(),
            }),
          ]),
        ),
      }),
      "Matching records found",
    ),
    [HttpStatusCodes.SERVICE_UNAVAILABLE]: jsonContent(
      error(QueryError.or(ConnectionError)),
      "Memory service unable to process query",
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      error(SystemError),
      "Memory service error",
    ),
  },
});

export const subscribe = createRoute({
  method: "get",
  path: "/api/storage/memory",
  tags,
  request: {
    headers: z.object({
      connection: z.literal("Upgrade"),
      upgrade: z.literal("websocket"),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      headers: z.object({
        connection: z.literal("Upgrade"),
        upgrade: z.literal("websocket"),
        "sec-websocket-accept": z.string(),
        date: z.string(),
      }),
      description: "WebSocket upgrade",
    },
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: {
      description: "Upgrade to websocket failed",
    },
  },
});
