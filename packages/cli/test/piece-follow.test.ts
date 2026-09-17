import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ValidationError } from "@cliffy/command";

import { followPieceSourceAction } from "../commands/piece.ts";
import { followPieceSource, type PieceConfig } from "../lib/piece.ts";

// Drives the `cf piece follow` action body and the lib function in-process
// with a stubbed connection, so the transition the piece controller makes —
// a `repoint` to the origin the caller named — and the two outcomes it
// reports are covered without a server.

const BASE_OPTIONS = {
  apiUrl: "http://127.0.0.1:8000",
  identity: "/nonexistent-but-unread.key",
  space: "did:key:zSpace",
  cell: "of:profile",
};

describe("cf piece follow", () => {
  describe("followPieceSource()", () => {
    it("repoints the resolved piece at the origin and reports the transition", async () => {
      const actions: unknown[] = [];
      const config: PieceConfig = {
        apiUrl: BASE_OPTIONS.apiUrl,
        identity: BASE_OPTIONS.identity,
        space: BASE_OPTIONS.space,
        piece: "of:profile",
      };
      const pieces = {
        get: (id: string) =>
          Promise.resolve({
            id,
            changeSource: (action: unknown) => {
              actions.push(action);
              return Promise.resolve({ status: "applied" as const });
            },
          }),
      };
      const result = await followPieceSource(
        config,
        "system:system/profile-home.tsx",
        {
          // deno-lint-ignore no-explicit-any
          loadPieces: () => Promise.resolve(pieces as any),
          resolvePieceAddress: () => Promise.resolve("of:profile"),
        },
      );
      expect(result).toEqual({ status: "applied" });
      expect(actions).toEqual([
        { kind: "repoint", url: "system:system/profile-home.tsx" },
      ]);
    });
  });

  describe("followPieceSourceAction()", () => {
    it("reports a follow that landed", async () => {
      const rendered: unknown[] = [];
      const hints: string[] = [];
      await followPieceSourceAction(
        BASE_OPTIONS,
        " system:system/profile-home.tsx ",
        {
          followPieceSource: (config, origin) => {
            expect(config.piece).toBe("of:profile");
            expect(origin).toBe("system:system/profile-home.tsx");
            return Promise.resolve({ status: "applied" });
          },
          render: (value) => rendered.push(value),
          hint: (message) => hints.push(message),
        },
      );
      expect(rendered).toEqual([
        "of:profile now follows system:system/profile-home.tsx",
      ]);
      expect(hints.join("\n")).toContain("cf piece inspect");
    });

    it("reports an incompatible candidate with its message and a non-zero exit", async () => {
      const codes: number[] = [];
      const rendered: unknown[] = [];
      await followPieceSourceAction(BASE_OPTIONS, "system:system/x.tsx", {
        followPieceSource: () =>
          Promise.resolve({
            status: "incompatible",
            message: "argument.name: newly required argument field",
            // deno-lint-ignore no-explicit-any
            prepared: {} as any,
          }),
        render: (value) => rendered.push(value),
        printError: () => {},
        setExitCode: (code) => codes.push(code),
      });
      expect(codes).toEqual([1]);
      expect(rendered).toEqual([]);
    });

    it("throws a `ValidationError` for a blank origin", async () => {
      await expect(
        followPieceSourceAction(BASE_OPTIONS, "   ", {
          followPieceSource: () => {
            throw new Error("must not connect");
          },
        }),
      ).rejects.toThrow(ValidationError);
    });
  });
});
