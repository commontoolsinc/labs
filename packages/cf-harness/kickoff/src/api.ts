/**
 * The kickoff server's HTTP surface, as the page calls it. The types come from
 * the server's own modules rather than being restated here, so a route that
 * changes shape is a type error in the page rather than a blank pane.
 */

import type { HarnessChatEventEnvelope } from "../../src/contracts/interactive-chat.ts";
import type { KickoffRunDetail } from "../run-store.ts";
import type { KickoffRunSummary } from "../runs.ts";
import type { KickoffSessionSummary } from "../sessions.ts";

export type {
  HarnessChatEventEnvelope,
  KickoffRunDetail,
  KickoffRunSummary,
  KickoffSessionSummary,
};

/** A started turn, and the session it runs in. */
export interface StartedTask {
  sessionId: string;
  turnId: string;
}

/**
 * One JSON response, or the error it reported. A refusal is not always JSON —
 * an unbuilt page and a crashed handler both answer in plain text — so the
 * body is parsed leniently and the status stands in when it carries nothing.
 */
const json = async <Value>(response: Response): Promise<Value> => {
  const text = await response.text();
  let body: { error?: unknown } | undefined;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : text.trim() === ""
        ? response.statusText
        : text,
    );
  }
  return body as Value;
};

export const startTask = async (
  text: string,
  sessionId?: string,
): Promise<StartedTask> =>
  await json<StartedTask>(
    await fetch("/api/task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        sessionId === undefined ? { text } : { text, sessionId },
      ),
    }),
  );

/**
 * Asks the server to stop a turn. A refusal rejects like every other route's
 * does: a cancel the server would not take leaves the turn running, and a page
 * that read it as success would say the opposite.
 */
export const cancelTurn = async (
  sessionId: string,
  turnId?: string,
): Promise<void> => {
  await json<unknown>(
    await fetch("/api/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, turnId }),
    }),
  );
};

export const listSessions = async (): Promise<
  readonly KickoffSessionSummary[]
> =>
  (await json<{ sessions: readonly KickoffSessionSummary[] }>(
    await fetch("/api/sessions"),
  )).sessions;

export const listRuns = async (): Promise<readonly KickoffRunSummary[]> =>
  (await json<{ runs: readonly KickoffRunSummary[] }>(
    await fetch("/api/runs"),
  )).runs;

export const readRun = async (runId: string): Promise<KickoffRunDetail> =>
  await json<KickoffRunDetail>(
    await fetch(`/api/runs/${encodeURIComponent(runId)}`),
  );

/**
 * One artifact or tool output as its own text. It is returned unparsed: the
 * point of the raw pane is to show what is on disk, including a payload that
 * is too large or too odd for the page to have an opinion about.
 */
export const readRunFile = async (
  runId: string,
  kind: "artifacts" | "tool-outputs",
  name: string,
): Promise<string> => {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/${kind}/${
      encodeURIComponent(name)
    }`,
  );
  if (!response.ok) {
    throw new Error(`${name} is not readable`);
  }
  return await response.text();
};
