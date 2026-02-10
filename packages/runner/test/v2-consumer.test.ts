import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  buildTransactCommand,
  buildQueryCommand,
  buildSubscribeCommand,
  buildUnsubscribeCommand,
  buildGraphQueryCommand,
  parseTransactResult,
  parseQueryResult,
} from "../src/storage/v2-consumer.ts";
import type { SpaceId } from "@commontools/memory/v2-types";

const SPACE: SpaceId = "did:key:z6MkTest";

// ---------------------------------------------------------------------------
// Command encoding
// ---------------------------------------------------------------------------

describe("v2-consumer command encoding", () => {
  it("builds a transact command", () => {
    const cmd = buildTransactCommand(SPACE, {
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: "urn:entity:1", value: { x: 1 } },
      ],
    });
    expect(cmd.cmd).toBe("/memory/transact");
    expect(cmd.sub).toBe(SPACE);
    expect(cmd.args.operations.length).toBe(1);
    expect(cmd.args.operations[0].op).toBe("set");
  });

  it("builds a query command", () => {
    const cmd = buildQueryCommand(SPACE, {
      select: { "urn:entity:1": {} },
      since: 5,
    });
    expect(cmd.cmd).toBe("/memory/query");
    expect(cmd.sub).toBe(SPACE);
    expect(cmd.args.since).toBe(5);
  });

  it("builds a subscribe command", () => {
    const cmd = buildSubscribeCommand(SPACE, {
      select: { "*": {} },
    });
    expect(cmd.cmd).toBe("/memory/query/subscribe");
    expect(cmd.sub).toBe(SPACE);
  });

  it("builds an unsubscribe command", () => {
    const cmd = buildUnsubscribeCommand(SPACE, "job:abc123");
    expect(cmd.cmd).toBe("/memory/query/unsubscribe");
    expect(cmd.sub).toBe(SPACE);
    expect(cmd.args.source).toBe("job:abc123");
  });

  it("builds a graph query command", () => {
    const cmd = buildGraphQueryCommand(SPACE, {
      selectSchema: {
        "urn:entity:1": { path: [], schema: true },
      },
      subscribe: true,
      excludeSent: true,
    });
    expect(cmd.cmd).toBe("/memory/graph/query");
    expect(cmd.args.subscribe).toBe(true);
    expect(cmd.args.excludeSent).toBe(true);
  });

  it("preserves optional fields in transact command", () => {
    const cmd = buildTransactCommand(SPACE, {
      reads: { confirmed: [], pending: [] },
      operations: [],
      codeCID: "bafy123",
      branch: "feature/test",
    });
    expect(cmd.args.codeCID).toBe("bafy123");
    expect(cmd.args.branch).toBe("feature/test");
  });

  it("preserves branch in query command", () => {
    const cmd = buildQueryCommand(SPACE, {
      select: { "*": {} },
      branch: "staging",
    });
    expect(cmd.args.branch).toBe("staging");
  });
});

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

describe("v2-consumer response parsing", () => {
  it("parses a successful transact result", () => {
    const result = parseTransactResult({
      ok: {
        hash: "abc",
        version: 1,
        branch: "",
        facts: [],
        createdAt: "2024-01-01",
      },
    });
    expect("ok" in result).toBe(true);
    if ("ok" in result) {
      expect(result.ok.version).toBe(1);
    }
  });

  it("parses a conflict error transact result", () => {
    const result = parseTransactResult({
      error: {
        name: "ConflictError",
        conflicts: [{ id: "urn:entity:1" }],
      },
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      const err = result.error as { name: string; conflicts: unknown[] };
      expect(err.name).toBe("ConflictError");
      expect(err.conflicts.length).toBe(1);
    }
  });

  it("parses a generic error transact result", () => {
    const result = parseTransactResult({
      error: { name: "InternalError", message: "something broke" },
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      const err = result.error as { name: string };
      expect(err.name).toBe("InternalError");
    }
  });

  it("parses an unknown response as error", () => {
    const result = parseTransactResult({ something: "unexpected" });
    expect("error" in result).toBe(true);
  });

  it("parses a successful query result", () => {
    const result = parseQueryResult({
      ok: { "urn:entity:1": { value: 42, version: 1, hash: "abc" } },
    });
    expect("ok" in result).toBe(true);
    if ("ok" in result) {
      expect(result.ok["urn:entity:1" as keyof typeof result.ok]).toBeDefined();
    }
  });

  it("parses an error query result", () => {
    const result = parseQueryResult({
      error: { name: "QueryError", message: "bad query" },
    });
    expect("error" in result).toBe(true);
  });

  it("parses a query result with no error detail", () => {
    const result = parseQueryResult({});
    expect("error" in result).toBe(true);
  });
});
