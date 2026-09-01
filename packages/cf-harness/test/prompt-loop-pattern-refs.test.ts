/**
 * A parent's selected pattern references cross delegation from the trusted
 * search record, not from model-retyped metadata or a delegation-time fetch.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";

import { Identity } from "@commonfabric/identity";

import { CfHarnessEngine } from "../src/engine.ts";
import { PatternIndexClient } from "../src/pattern-index/client.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type { HarnessFetch } from "../src/contracts/http-fetch.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "./support/responses-fixture.ts";

const signer = await Identity.fromPassphrase(
  "cf-harness prompt-loop pattern refs",
);

const SEARCH_HIT = {
  patternId: "pat-expenses",
  description: "Totals an expense list",
  hashtags: ["expenses", "money"],
  ownerDid: "did:key:zOwner",
  createdAt: "2026-08-01T00:00:00.000Z",
  dependencies: [],
  signals: { uses: 12, score: 2 },
  quality: "proven",
  kind: "part",
  matchedTerms: 2,
  queryTerms: 3,
};

const PATTERN_RECORD = {
  patternId: SEARCH_HIT.patternId,
  ownerDid: SEARCH_HIT.ownerDid,
  createdAt: SEARCH_HIT.createdAt,
  description: SEARCH_HIT.description,
  hashtags: SEARCH_HIT.hashtags,
  dependencies: [],
  argumentSchema: {
    type: "object",
    properties: {
      amounts: { type: "array", items: { type: "number" } },
    },
    required: ["amounts"],
  },
  resultSchema: {
    type: "object",
    properties: { total: { type: "number" } },
    required: ["total"],
  },
};

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

const toolCallTurn = (
  id: string,
  name: string,
  input: Record<string, unknown>,
) => ({
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      }],
    },
  }],
});

const assistantTurn = (content: string) => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

interface IndexStub {
  fetchFn: HarnessFetch;
  calls: string[];
}

/** Index fixture which records every endpoint call. */
const stubIndex = (): IndexStub => {
  const calls: string[] = [];
  const fetchFn: HarnessFetch = (input) => {
    const fn = String(input).split("/").pop() ?? "";
    calls.push(fn);
    return Promise.resolve(
      new Response(
        JSON.stringify(
          fn === "searchPatterns" ? { results: [SEARCH_HIT] } : PATTERN_RECORD,
        ),
        { status: 200 },
      ),
    );
  };
  return { fetchFn, calls };
};

interface DelegationFixture {
  childPrompt: string;
  indexCalls: readonly string[];
  delegateOutput: Record<string, unknown>;
  subagentRuns: number;
}

/** Runs one parent search followed by one pattern-reference delegation. */
const runDelegation = async (
  patternRefs: readonly Record<string, unknown>[],
): Promise<DelegationFixture> => {
  const index = stubIndex();
  const modelRequests: unknown[] = [];
  const modelTurns = [
    toolCallTurn("call-search", "search_patterns", {
      text: "expense list totals",
    }),
    toolCallTurn("call-delegate", "delegate_task", {
      goal: "Use the selected pattern metadata to plan the focused task.",
      context: "Keep the answer concise.",
      patternRefs,
    }),
    assistantTurn("Child completed the focused task."),
    assistantTurn("Parent received the delegation result."),
  ];
  const fetchFn: typeof fetch = (_input, init) => {
    modelRequests.push(JSON.parse(String(init?.body)));
    const turn = modelTurns[modelRequests.length - 1];
    if (turn === undefined) {
      throw new Error("scripted model ran out of turns");
    }
    return Promise.resolve(
      new Response(JSON.stringify(responsesBodyFromChatFixture(turn)), {
        status: 200,
      }),
    );
  };
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: `run-pattern-refs-${crypto.randomUUID()}`,
    model: "gpt-5.4",
    cfcEnforcementMode: "disabled",
    patternIndexClientFactory: () =>
      Promise.resolve(
        new PatternIndexClient({
          baseUrl: "https://index.test",
          fetchFn: index.fetchFn,
          signer,
        }),
      ),
  });
  const loop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine,
    allowedToolIds: ["search_patterns", "delegate_task"],
    allowedSubagentProfiles: ["default"],
    fetchFn,
  });

  const result = await loop.runPrompt({ prompt: "Search, then delegate." });
  const delegateMessage = result.transcript.find((message) =>
    message.role === "tool" && message.toolName === "delegate_task"
  );
  if (delegateMessage?.role !== "tool") {
    throw new Error("expected a `delegate_task` tool result");
  }
  const childRequest = modelRequests[2] === undefined
    ? undefined
    : chatViewOfRequest(modelRequests[2]);

  return {
    childPrompt: childRequest?.messages.at(-1)?.content ?? "",
    indexCalls: index.calls,
    delegateOutput: JSON.parse(delegateMessage.content),
    subagentRuns: result.runState.subagentRuns?.length ?? 0,
  };
};

/** Starts a fresh parent loop over a transcript whose earlier loop searched. */
const runResumedDelegation = async (): Promise<DelegationFixture> => {
  const index = stubIndex();
  const firstRequests: unknown[] = [];
  const firstTurns = [
    toolCallTurn("call-search", "search_patterns", {
      text: "expense list totals",
    }),
    assistantTurn("Search complete."),
  ];
  const firstFetch: typeof fetch = (_input, init) => {
    firstRequests.push(JSON.parse(String(init?.body)));
    const turn = firstTurns[firstRequests.length - 1];
    if (turn === undefined) {
      throw new Error("first scripted model ran out of turns");
    }
    return Promise.resolve(
      new Response(JSON.stringify(responsesBodyFromChatFixture(turn)), {
        status: 200,
      }),
    );
  };
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: `run-pattern-refs-resume-${crypto.randomUUID()}`,
    model: "gpt-5.4",
    cfcEnforcementMode: "disabled",
    patternIndexClientFactory: () =>
      Promise.resolve(
        new PatternIndexClient({
          baseUrl: "https://index.test",
          fetchFn: index.fetchFn,
          signer,
        }),
      ),
  });
  const firstLoop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine,
    allowedToolIds: ["search_patterns", "delegate_task"],
    allowedSubagentProfiles: ["default"],
    fetchFn: firstFetch,
  });
  const firstResult = await firstLoop.runPrompt({ prompt: "Search first." });

  const resumedRequests: unknown[] = [];
  const resumedTurns = [
    toolCallTurn("call-delegate", "delegate_task", {
      goal: "Use the pattern searched before this parent loop resumed.",
      patternRefs: [{ patternId: SEARCH_HIT.patternId }],
    }),
    assistantTurn("Child completed the resumed task."),
    assistantTurn("Parent received the resumed delegation result."),
  ];
  const resumedFetch: typeof fetch = (_input, init) => {
    resumedRequests.push(JSON.parse(String(init?.body)));
    const turn = resumedTurns[resumedRequests.length - 1];
    if (turn === undefined) {
      throw new Error("resumed scripted model ran out of turns");
    }
    return Promise.resolve(
      new Response(JSON.stringify(responsesBodyFromChatFixture(turn)), {
        status: 200,
      }),
    );
  };
  const resumedLoop = new CfHarnessPromptLoop({
    apiKey: "test-key",
    engine,
    allowedToolIds: ["search_patterns", "delegate_task"],
    allowedSubagentProfiles: ["default"],
    fetchFn: resumedFetch,
  });
  const result = await resumedLoop.runTranscript({
    transcript: [
      ...firstResult.transcript,
      { role: "user", content: "Delegate using the earlier search." },
    ],
  });
  const delegateMessage = result.transcript.findLast((message) =>
    message.role === "tool" && message.toolName === "delegate_task"
  );
  if (delegateMessage?.role !== "tool") {
    throw new Error("expected a resumed `delegate_task` tool result");
  }
  const childRequest = resumedRequests[1] === undefined
    ? undefined
    : chatViewOfRequest(resumedRequests[1]);
  return {
    childPrompt: childRequest?.messages.at(-1)?.content ?? "",
    indexCalls: index.calls,
    delegateOutput: JSON.parse(delegateMessage.content),
    subagentRuns: result.runState.subagentRuns?.length ?? 0,
  };
};

describe("prompt-loop pattern references", () => {
  it("rehydrates a selected hit into neutral child context", async () => {
    const result = await runDelegation([{
      patternId: SEARCH_HIT.patternId,
      note: "Use this as available evidence; do not assume it is mandatory.",
    }]);

    expect(result.subagentRuns).toBe(1);
    expect(result.childPrompt).toBe(
      `Task:
Use the selected pattern metadata to plan the focused task.

Context:
Keep the answer concise.

Published pattern references selected by the parent:
These records from the parent's earlier searches are available for this delegated task.

Pattern 1: pat-expenses
Kind: part
Quality: proven
Description: Totals an expense list
Match: 2 of 3 stopword-free query terms
Import: import X from "cf:pattern:pat-expenses"
Argument shape:
{
  amounts: number[]
}
Result shape:
{
  total: number
}
Parent note:
Use this as available evidence; do not assume it is mandatory.`,
    );
  });

  it("names each unseen id as an inert refusal and omits it from child context", async () => {
    const result = await runDelegation([{
      patternId: SEARCH_HIT.patternId,
    }, {
      patternId: "pat-never-searched",
      note: "This note must not make an unseen id trusted.",
    }]);

    expect(result.subagentRuns).toBe(1);
    expect(result.childPrompt).toContain(SEARCH_HIT.patternId);
    expect(result.childPrompt).not.toContain("pat-never-searched");
    expect(result.delegateOutput.patternRefRefusals).toEqual([{
      patternId: "pat-never-searched",
      reason: "not-searched-by-parent",
    }]);
  });

  it("performs no index call while resolving a delegation", async () => {
    const result = await runDelegation([{
      patternId: SEARCH_HIT.patternId,
    }]);

    expect(result.subagentRuns).toBe(1);
    expect(result.childPrompt).toContain(SEARCH_HIT.patternId);
    expect(result.indexCalls).toEqual(["searchPatterns", "getPattern"]);
  });

  it("rehydrates an earlier search after the parent loop resumes", async () => {
    const result = await runResumedDelegation();

    expect(result.subagentRuns).toBe(1);
    expect(result.childPrompt).toContain(SEARCH_HIT.patternId);
    expect(result.delegateOutput.patternRefRefusals).toBeUndefined();
    expect(result.indexCalls).toEqual(["searchPatterns", "getPattern"]);
  });
});
