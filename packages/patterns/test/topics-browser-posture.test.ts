import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type ServedBundle,
  topicsBrowserPostureOf,
} from "../integration/topics-browser-posture.ts";

/** A served bundle carrying the build define `value` as the bundler emits it. */
function bundleWith(value: string): ServedBundle {
  return {
    kind: "read",
    source:
      `var EXPERIMENTAL_SERVER_EXECUTION_DEFINE = true ? "${value}" : void 0;`,
  };
}

describe("topicsBrowserPostureOf()", () => {
  it("returns `server-execution-off` when the toolshed and its shell both run off", () => {
    const posture = topicsBrowserPostureOf({
      experimental: { serverExecution: false },
      shellServerExecutionDefine: "false",
    });
    expect(posture.mode).toBe("server-execution-off");
    expect(posture.served).toBe(false);
    expect(posture.client).toBe(false);
    expect(posture.clientFrom).toBe("meta");
  });

  it("returns `server-execution-on` when the toolshed and its shell both run on", () => {
    const posture = topicsBrowserPostureOf({
      experimental: { serverExecution: true },
      shellServerExecutionDefine: "true",
    });
    expect(posture.mode).toBe("server-execution-on");
    expect(posture.clientFrom).toBe("meta");
  });

  it("reads the shell's posture from the bundle when the toolshed reports no baked define", () => {
    const posture = topicsBrowserPostureOf(
      {
        experimental: { serverExecution: true },
        shellServerExecutionDefine: null,
      },
      bundleWith("true"),
    );
    expect(posture.mode).toBe("server-execution-on");
    expect(posture.client).toBe(true);
    expect(posture.clientFrom).toBe("bundle");
  });

  it("throws when a bundle was read and names no define", () => {
    expect(() =>
      topicsBrowserPostureOf(
        { experimental: { serverExecution: false } },
        { kind: "read", source: "var somethingElse = 1;" },
      )
    ).toThrow(/names no `EXPERIMENTAL_SERVER_EXECUTION` build define/);
  });

  it("throws naming the reason when no bundle could be read", () => {
    expect(() =>
      topicsBrowserPostureOf(
        {
          experimental: { serverExecution: false },
          shellServerExecutionDefine: null,
        },
        { kind: "unreachable", reason: "`/scripts/index.js` gave 404" },
      )
    ).toThrow(
      /no served shell could be read \(`\/scripts\/index\.js` gave 404\)/,
    );
  });

  it("throws naming both halves when the toolshed and its shell run opposite postures", () => {
    expect(() =>
      topicsBrowserPostureOf({
        experimental: { serverExecution: true },
        shellServerExecutionDefine: "false",
      })
    ).toThrow(
      /serves `serverExecution=true` while the shell it serves runs `false`/,
    );
  });

  it("throws when the toolshed reports no resolved `serverExecution`", () => {
    expect(() => topicsBrowserPostureOf({ experimental: {} })).toThrow(
      /reports no resolved `serverExecution`/,
    );
  });

  it("throws when a baked define spells neither `true` nor `false`", () => {
    expect(() =>
      topicsBrowserPostureOf(
        { experimental: { serverExecution: true } },
        bundleWith("yes"),
      )
    ).toThrow(/spells neither `true` nor `false`: "yes"/);
  });
});
