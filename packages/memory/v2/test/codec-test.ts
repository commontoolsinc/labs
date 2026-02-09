/**
 * Tests for v2 wire codec.
 * Verifies JSON round-trip for all command and message types.
 */

import { assertEquals } from "@std/assert";
import {
  decodeCommand,
  decodeMessage,
  encodeCommand,
  encodeMessage,
} from "../codec.ts";
import type { InvocationId, ProviderMessage } from "../protocol.ts";
import type { Reference } from "../types.ts";

Deno.test("codec: round-trip transact command", () => {
  const id: InvocationId = "job:0";
  const cmd = {
    cmd: "/memory/transact" as const,
    sub: "did:key:test" as `did:${string}`,
    args: {
      reads: { confirmed: [], pending: [] },
      operations: [
        {
          op: "set" as const,
          id: "e1",
          value: "hello",
          parent: "ref:empty" as unknown as Reference,
        },
      ],
    },
  };

  const encoded = encodeCommand(id, cmd);
  const decoded = decodeCommand(encoded);

  assertEquals(decoded.id, id);
  assertEquals(decoded.cmd.cmd, "/memory/transact");
  assertEquals((decoded.cmd as any).args.operations[0].value, "hello");
});

Deno.test("codec: round-trip query command", () => {
  const id: InvocationId = "job:1";
  const cmd = {
    cmd: "/memory/query" as const,
    sub: "did:key:test" as `did:${string}`,
    args: {
      select: { "entity1": {}, "*": {} },
      since: 5,
    },
  };

  const encoded = encodeCommand(id, cmd);
  const decoded = decodeCommand(encoded);

  assertEquals(decoded.id, id);
  assertEquals(decoded.cmd.cmd, "/memory/query");
  assertEquals((decoded.cmd as any).args.since, 5);
});

Deno.test("codec: round-trip subscribe command", () => {
  const id: InvocationId = "job:2";
  const cmd = {
    cmd: "/memory/query/subscribe" as const,
    sub: "did:key:test" as `did:${string}`,
    args: {
      select: { "*": {} },
      branch: "feature-x",
    },
  };

  const encoded = encodeCommand(id, cmd);
  const decoded = decodeCommand(encoded);

  assertEquals(decoded.id, id);
  assertEquals(decoded.cmd.cmd, "/memory/query/subscribe");
  assertEquals((decoded.cmd as any).args.branch, "feature-x");
});

Deno.test("codec: round-trip unsubscribe command", () => {
  const id: InvocationId = "job:3";
  const cmd = {
    cmd: "/memory/query/unsubscribe" as const,
    sub: "did:key:test" as `did:${string}`,
    args: {
      source: "job:2" as InvocationId,
    },
  };

  const encoded = encodeCommand(id, cmd);
  const decoded = decodeCommand(encoded);

  assertEquals(decoded.id, id);
  assertEquals(decoded.cmd.cmd, "/memory/query/unsubscribe");
});

Deno.test("codec: round-trip task/return transact success", () => {
  const msg: ProviderMessage = {
    the: "task/return",
    of: "job:0" as InvocationId,
    is: {
      ok: {
        hash: "abc123" as any,
        version: 1,
        branch: "",
        facts: [
          {
            hash: "fact-hash-1" as any,
            fact: {
              type: "set",
              id: "e1",
              value: "hello",
              parent: "ref:empty" as any,
            },
            version: 1,
            commitHash: "abc123" as any,
          },
        ],
        createdAt: "2025-01-01T00:00:00.000Z",
      },
    },
  };

  const encoded = encodeMessage(msg);
  const decoded = decodeMessage(encoded);

  assertEquals(decoded.the, "task/return");
  assertEquals(decoded.of, "job:0");
  assertEquals((decoded.is as any).ok.version, 1);
});

Deno.test("codec: round-trip task/return transact error", () => {
  const msg: ProviderMessage = {
    the: "task/return",
    of: "job:1" as InvocationId,
    is: {
      error: {
        name: "ConflictError",
        commit: { reads: { confirmed: [], pending: [] }, operations: [] },
        conflicts: [],
      },
    },
  };

  const encoded = encodeMessage(msg);
  const decoded = decodeMessage(encoded);

  assertEquals(decoded.the, "task/return");
  assertEquals((decoded.is as any).error.name, "ConflictError");
});

Deno.test("codec: round-trip task/effect subscription update", () => {
  const msg: ProviderMessage = {
    the: "task/effect",
    of: "job:sub1" as InvocationId,
    is: {
      commit: {
        hash: "commit-hash" as any,
        version: 3,
        branch: "",
        facts: [
          {
            hash: "def456" as any,
            fact: {
              type: "set",
              id: "e2",
              value: 42,
              parent: "ref:prev" as any,
            },
            version: 3,
            commitHash: "commit-hash" as any,
          },
        ],
        createdAt: "2025-01-01T00:00:00.000Z",
      },
      revisions: [
        {
          hash: "def456" as any,
          fact: {
            type: "set",
            id: "e2",
            value: 42,
            parent: "ref:prev" as any,
          },
          version: 3,
          commitHash: "commit-hash" as any,
        },
      ],
    },
  };

  const encoded = encodeMessage(msg);
  const decoded = decodeMessage(encoded);

  assertEquals(decoded.the, "task/effect");
  assertEquals(decoded.of, "job:sub1");
  assertEquals((decoded.is as any).commit.version, 3);
});

Deno.test("codec: round-trip query result", () => {
  const msg: ProviderMessage = {
    the: "task/return",
    of: "job:q1" as InvocationId,
    is: {
      ok: {
        "entity1": {
          version: 1,
          hash: "abc" as any,
          value: { name: "test" },
        },
        "entity2": { version: 2, hash: "def" as any, value: null },
      },
    },
  };

  const encoded = encodeMessage(msg);
  const decoded = decodeMessage(encoded);

  assertEquals(decoded.the, "task/return");
  assertEquals((decoded.is as any).ok.entity1.value.name, "test");
});

Deno.test("codec: handles nested objects and arrays", () => {
  const id: InvocationId = "job:nested";
  const cmd = {
    cmd: "/memory/transact" as const,
    sub: "did:key:test" as `did:${string}`,
    args: {
      reads: { confirmed: [], pending: [] },
      operations: [
        {
          op: "set" as const,
          id: "complex",
          value: {
            nested: { deep: [1, 2, { three: true }] },
            array: ["a", "b"],
            number: 42.5,
            bool: false,
            nullVal: null,
          },
          parent: "ref:empty" as unknown as Reference,
        },
      ],
    },
  };

  const encoded = encodeCommand(id, cmd);
  const decoded = decodeCommand(encoded);

  const val = (decoded.cmd as any).args.operations[0].value;
  assertEquals(val.nested.deep[2].three, true);
  assertEquals(val.number, 42.5);
  assertEquals(val.nullVal, null);
});

Deno.test("codec: round-trip branch commands", () => {
  const id: InvocationId = "job:branch";
  const cmd = {
    cmd: "/memory/branch/create" as const,
    sub: "did:key:test" as `did:${string}`,
    args: {
      name: "feature-branch",
      fromBranch: "",
      atVersion: 5,
    },
  };

  const encoded = encodeCommand(id, cmd);
  const decoded = decodeCommand(encoded);

  assertEquals(decoded.cmd.cmd, "/memory/branch/create");
  assertEquals((decoded.cmd as any).args.name, "feature-branch");
});

Deno.test("codec: preserves empty strings and zero values", () => {
  const id: InvocationId = "job:edge";
  const cmd = {
    cmd: "/memory/transact" as const,
    sub: "did:key:test" as `did:${string}`,
    args: {
      reads: { confirmed: [], pending: [] },
      operations: [
        {
          op: "set" as const,
          id: "",
          value: "",
          parent: "" as unknown as Reference,
        },
        {
          op: "set" as const,
          id: "zero",
          value: 0,
          parent: "ref:zero" as unknown as Reference,
        },
      ],
      branch: "",
    },
  };

  const encoded = encodeCommand(id, cmd);
  const decoded = decodeCommand(encoded);

  const ops = (decoded.cmd as any).args.operations;
  assertEquals(ops[0].id, "");
  assertEquals(ops[0].value, "");
  assertEquals(ops[1].value, 0);
  assertEquals((decoded.cmd as any).args.branch, "");
});
