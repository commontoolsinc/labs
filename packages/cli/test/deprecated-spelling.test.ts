import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  COMMAND_SPELLING_END_DATE,
  warnDeprecatedCommandSpelling,
  withDeprecatedCommandSpelling,
} from "../lib/deprecated-spelling.ts";

describe("deprecated-spelling", () => {
  describe("COMMAND_SPELLING_END_DATE", () => {
    it("is a fixed calendar day", () => {
      expect(COMMAND_SPELLING_END_DATE).toBe("2026-09-11");
    });

    it("reads the same however long apart two callers see it", () => {
      // The guarantee is that the date does not move with the clock, so the
      // check is that the same notice text comes back under two different
      // wall-clock readings rather than that two adjacent calls agree.
      const lines: string[] = [];
      const write = (text: string) => lines.push(text);
      const realNow = Date.now;
      try {
        Date.now = () => new Date("2026-09-01T00:00:00Z").getTime();
        warnDeprecatedCommandSpelling("view", "source view", {
          writeError: write,
        });
        Date.now = () => new Date("2026-12-25T00:00:00Z").getTime();
        warnDeprecatedCommandSpelling("view", "source view", {
          writeError: write,
        });
      } finally {
        Date.now = realNow;
      }
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(lines[1]);
      expect(lines[0]).toContain("2026-09-11");
    });
  });

  describe("warnDeprecatedCommandSpelling()", () => {
    it("names the spelling written, the spelling to write, and the end date", () => {
      const lines: string[] = [];
      warnDeprecatedCommandSpelling("piece view", "piece view", {
        writeError: (text) => lines.push(text),
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("'cf piece view' is deprecated");
      expect(lines[0]).toContain("spell it 'cf piece view'");
      expect(lines[0]).toContain(COMMAND_SPELLING_END_DATE);
    });

    it("distinguishes the two spellings when they differ", () => {
      // A notice that printed the same word twice would pass a check that
      // only looked for the old spelling, so the two are pinned apart.
      const lines: string[] = [];
      warnDeprecatedCommandSpelling("get", "cell get", {
        writeError: (text) => lines.push(text),
      });
      expect(lines[0]).toContain("'cf get' is deprecated");
      expect(lines[0]).toContain("spell it 'cf cell get'");
    });

    it("writes to stderr and puts nothing on stdout", () => {
      // stdout carries machine-readable output on several of the commands
      // this notice is mounted under, so a notice there would corrupt it.
      const errors: string[] = [];
      const out: string[] = [];
      const realError = console.error;
      const realLog = console.log;
      try {
        console.error = (text: string) => errors.push(text);
        console.log = (text: string) => out.push(text);
        warnDeprecatedCommandSpelling("check", "source check");
      } finally {
        console.error = realError;
        console.log = realLog;
      }
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("'cf check' is deprecated");
      expect(out).toEqual([]);
    });
  });

  describe("withDeprecatedCommandSpelling()", () => {
    it("emits the notice before running the action", () => {
      const events: string[] = [];
      const realError = console.error;
      try {
        console.error = () => events.push("notice");
        const wrapped = withDeprecatedCommandSpelling(
          "acl ls",
          "space acl ls",
          () => {
            events.push("action");
          },
        );
        wrapped();
      } finally {
        console.error = realError;
      }
      expect(events).toEqual(["notice", "action"]);
    });

    it("returns what the action returns", () => {
      const realError = console.error;
      try {
        console.error = () => {};
        const wrapped = withDeprecatedCommandSpelling(
          "view",
          "source view",
          (n: number) => n * 2,
        );
        expect(wrapped(21)).toBe(42);
      } finally {
        console.error = realError;
      }
    });

    it("passes its arguments through in order", () => {
      const seen: unknown[] = [];
      const realError = console.error;
      try {
        console.error = () => {};
        const wrapped = withDeprecatedCommandSpelling(
          "view",
          "source view",
          (...args: unknown[]) => {
            seen.push(...args);
          },
        );
        wrapped({ json: true }, "first", "second");
      } finally {
        console.error = realError;
      }
      expect(seen).toEqual([{ json: true }, "first", "second"]);
    });

    it("keeps the action's `this` binding", () => {
      // A callable command's action reads `this.getLiteralArgs()`, so a
      // wrapper that dropped the receiver would break the words after `--`.
      const realError = console.error;
      try {
        console.error = () => {};
        const wrapped = withDeprecatedCommandSpelling(
          "call",
          "piece call",
          function (this: { literalArgs: string[] }) {
            return this.literalArgs;
          },
        );
        const receiver = { literalArgs: ["a", "b"], run: wrapped };
        expect(receiver.run()).toEqual(["a", "b"]);
      } finally {
        console.error = realError;
      }
    });
  });
});
