import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";

import { topicsBrowserPostureOf } from "./topics-browser-posture.ts";

/** A bundle carrying the build define `value` the way the bundler emits it. */
function bundleWith(value: string): string {
  return `var EXPERIMENTAL_SERVER_EXECUTION_DEFINE = true ? "${value}" : void 0;`;
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

  it("falls back to the first-party default when neither the toolshed nor a bundle names a define", () => {
    const posture = topicsBrowserPostureOf({
      experimental: { serverExecution: SERVER_EXECUTION_DEFAULT_ENABLED },
      shellServerExecutionDefine: null,
    });
    expect(posture.client).toBe(SERVER_EXECUTION_DEFAULT_ENABLED);
    expect(posture.clientFrom).toBe("default");
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
