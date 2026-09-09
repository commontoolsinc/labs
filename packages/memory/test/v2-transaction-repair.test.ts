import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type ClientCommit,
  type Operation,
  ProtocolError,
  resolveScopeKey,
  toDocumentPath,
  toValuePath,
} from "../v2.ts";
import {
  type CommitRepairAddress,
  getCommitRepairFootprint,
  resolveCommitRepairAddress,
} from "../v2/transaction-repair.ts";

describe("transaction repair addresses", () => {
  describe("getCommitRepairFootprint()", () => {
    it("returns an empty footprint for an empty transaction", () => {
      expect(getCommitRepairFootprint({
        reads: { confirmed: [], pending: [] },
        operations: [],
      })).toEqual([]);
    });

    it("includes all document operation kinds and excludes the SQLite target", () => {
      const operations = {
        set: { op: "set", id: "of:set", value: { value: null } },
        patch: { op: "patch", id: "of:patch", patches: [] },
        delete: { op: "delete", id: "of:delete" },
        "apply-op": {
          op: "apply-op",
          id: "of:apply",
          path: toValuePath(["body"]),
          codec: "test-codec",
          submissionId: "edit",
          base: null,
          payload: null,
        },
        "release-op-field": {
          op: "release-op-field",
          id: "of:release",
          path: toValuePath(["body"]),
          codec: "test-codec",
          cursor: { epoch: 1, version: 1 },
        },
        sqlite: {
          op: "sqlite",
          db: { id: "of:database", scope: "user" },
          sql: "INSERT INTO entries VALUES (1)",
        },
      } satisfies Record<Operation["op"], Operation>;

      expect(getCommitRepairFootprint({
        branch: "working",
        operations: Object.values(operations),
        reads: {
          confirmed: [{ id: "of:schema", path: toDocumentPath([]), seq: 4 }],
          pending: [],
        },
      })).toEqual([
        { branch: "working", id: "of:set", scope: "space" },
        { branch: "working", id: "of:patch", scope: "space" },
        { branch: "working", id: "of:delete", scope: "space" },
        { branch: "working", id: "of:apply", scope: "space" },
        { branch: "working", id: "of:release", scope: "space" },
        { branch: "working", id: "of:schema", scope: "space" },
      ]);
    });

    it("deduplicates paths and versions across writes and both read sets", () => {
      expect(getCommitRepairFootprint({
        operations: [
          { op: "set", id: "of:output", value: { value: null } },
          { op: "delete", id: "of:output", scope: "space" },
        ],
        reads: {
          confirmed: [
            { id: "of:output", path: toDocumentPath(["value"]), seq: 0 },
            { id: "of:input", path: toDocumentPath(["value", "a"]), seq: 3 },
            {
              id: "of:input",
              path: toDocumentPath(["value"]),
              seq: 4,
              nonRecursive: true,
            },
          ],
          pending: [
            { id: "of:input", path: toDocumentPath([]), localSeq: 1 },
            {
              id: "of:pending",
              path: toDocumentPath(["value"]),
              localSeq: [1, 2],
            },
          ],
        },
      })).toEqual([
        { branch: "", id: "of:output", scope: "space" },
        { branch: "", id: "of:input", scope: "space" },
        { branch: "", id: "of:pending", scope: "space" },
      ]);
    });

    it("retains the same output ID separately in space, user, and session scope", () => {
      expect(getCommitRepairFootprint({
        operations: [
          { op: "patch", id: "of:output", patches: [] },
          {
            op: "set",
            id: "of:output",
            scope: "user",
            value: { value: null },
          },
        ],
        reads: {
          confirmed: [
            {
              id: "of:output",
              scope: "user",
              path: toDocumentPath(["value"]),
              seq: 0,
            },
          ],
          pending: [
            {
              id: "of:output",
              scope: "session",
              path: toDocumentPath([]),
              localSeq: 2,
            },
          ],
        },
      })).toEqual([
        { branch: "", id: "of:output", scope: "space" },
        { branch: "", id: "of:output", scope: "user" },
        { branch: "", id: "of:output", scope: "session" },
      ]);
    });

    it("preserves explicit read branches including the default branch", () => {
      expect(getCommitRepairFootprint({
        branch: "target",
        operations: [{ op: "delete", id: "of:shared", scope: "user" }],
        reads: {
          confirmed: [
            {
              id: "of:shared",
              scope: "user",
              path: toDocumentPath([]),
              seq: 1,
            },
            {
              id: "of:shared",
              scope: "user",
              branch: "source",
              path: toDocumentPath([]),
              seq: 2,
            },
            {
              id: "of:shared",
              scope: "user",
              branch: "",
              path: toDocumentPath([]),
              seq: 3,
            },
          ],
          pending: [
            {
              id: "of:shared",
              scope: "user",
              path: toDocumentPath([]),
              localSeq: 1,
            },
          ],
        },
      })).toEqual([
        { branch: "target", id: "of:shared", scope: "user" },
        { branch: "source", id: "of:shared", scope: "user" },
        { branch: "", id: "of:shared", scope: "user" },
      ]);
    });

    it("does not discover dependencies by traversing a proposed document value", () => {
      const commit: ClientCommit = {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:output",
          value: {
            value: { "/": { "link@1": { id: "of:unread", path: [] } } },
          },
        }],
      };
      expect(getCommitRepairFootprint(commit)).toEqual([
        { branch: "", id: "of:output", scope: "space" },
      ]);
    });
  });

  describe("resolveCommitRepairAddress()", () => {
    it("resolves a space address without a principal", () => {
      expect(resolveCommitRepairAddress({
        branch: "source",
        id: "of:shared",
        scope: "space",
      }, {})).toEqual({
        branch: "source",
        id: "of:shared",
        scope: "space",
        scopeKey: "space",
      });
    });

    it("resolves distinct user instances using the supplied principal", () => {
      const address: CommitRepairAddress = {
        branch: "",
        id: "of:output",
        scope: "user",
      };
      const first = { principal: "did:key:first", sessionId: "session" };
      const second = { principal: "did:key:second", sessionId: "session" };
      const a = resolveCommitRepairAddress(address, first);
      const b = resolveCommitRepairAddress(address, second);
      expect(a.scopeKey).toBe(resolveScopeKey("user", first));
      expect(b.scopeKey).toBe(resolveScopeKey("user", second));
      expect(a.scopeKey).not.toBe(b.scopeKey);
      expect(a.id).toBe(address.id);
      expect(a.branch).toBe(address.branch);
    });

    it("resolves distinct session instances for the same principal", () => {
      const address: CommitRepairAddress = {
        branch: "",
        id: "of:output",
        scope: "session",
      };
      const first = { principal: "did:key:first", sessionId: "one" };
      const second = { principal: "did:key:first", sessionId: "two" };
      const a = resolveCommitRepairAddress(address, first);
      const b = resolveCommitRepairAddress(address, second);
      expect(a.scopeKey).toBe(resolveScopeKey("session", first));
      expect(b.scopeKey).toBe(resolveScopeKey("session", second));
      expect(a.scopeKey).not.toBe(b.scopeKey);
    });

    it("throws when a user address has no principal", () => {
      expect(() =>
        resolveCommitRepairAddress({
          branch: "",
          id: "of:output",
          scope: "user",
        }, { sessionId: "one" })
      ).toThrow(ProtocolError);
    });

    it("throws when a session address has no session identity", () => {
      expect(() =>
        resolveCommitRepairAddress({
          branch: "",
          id: "of:output",
          scope: "session",
        }, { principal: "did:key:first" })
      ).toThrow(ProtocolError);
    });
  });
});
