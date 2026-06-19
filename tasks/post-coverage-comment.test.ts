import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { COVERAGE_SUGGESTION_MARKER } from "./perf-lib.ts";
import { postCoverageComment } from "./post-coverage-comment.ts";

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
}

/**
 * Run postCoverageComment with a payload file and a fetch mock that returns the
 * given existing comments for the GET and records any POST/PATCH.
 */
async function runWithPayload(
  payload: unknown,
  existingCommentBodies: string[],
  options: { getStatus?: number } = {},
): Promise<RecordedRequest[]> {
  const dir = await Deno.makeTempDir({ prefix: "coverage-comment-test-" });
  const file = path.join(dir, "coverage-comment.json");
  await Deno.writeTextFile(file, JSON.stringify(payload));

  const requests: RecordedRequest[] = [];
  const originalFetch = globalThis.fetch;
  Deno.env.set("COVERAGE_COMMENT_FILE", file);

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (method === "POST" || method === "PATCH") {
      const parsed = JSON.parse(String(init?.body));
      requests.push({ method, url, body: parsed.body });
      return Promise.resolve(
        new Response(JSON.stringify({ id: 1 }), {
          status: method === "POST" ? 201 : 200,
        }),
      );
    }

    // GET comments. A non-200 status (404 is non-retryable) makes the lookup
    // throw, exercising the best-effort error path.
    const getStatus = options.getStatus ?? 200;
    if (getStatus !== 200) {
      return Promise.resolve(
        new Response("not found", { status: getStatus }),
      );
    }
    // One page, fewer than per_page so pagination stops.
    const comments = existingCommentBodies.map((body, index) => ({
      id: index + 1,
      body,
    }));
    return Promise.resolve(
      new Response(JSON.stringify(comments), { status: 200 }),
    );
  }) as typeof fetch;

  try {
    await postCoverageComment();
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.delete("COVERAGE_COMMENT_FILE");
    await Deno.remove(dir, { recursive: true });
  }

  return requests;
}

Deno.test("postCoverageComment posts when no marked comment exists", async () => {
  const body = `${COVERAGE_SUGGESTION_MARKER}\nCover these lines.`;
  const requests = await runWithPayload(
    { prNumber: 4211, state: "regressed", body },
    ["a normal review comment"],
  );

  assertEquals(requests.length, 1);
  assertEquals(requests[0].method, "POST");
  assertEquals(
    requests[0].url,
    "https://api.github.com/repos/commontoolsinc/labs/issues/4211/comments",
  );
  assertEquals(requests[0].body, body);
});

Deno.test("postCoverageComment updates the existing comment in place", async () => {
  const body = `${COVERAGE_SUGGESTION_MARKER}\nCover these.`;
  const requests = await runWithPayload(
    { prNumber: 4211, state: "regressed", body },
    [`${COVERAGE_SUGGESTION_MARKER}\nan earlier run said this`],
  );

  assertEquals(requests.length, 1);
  assertEquals(requests[0].method, "PATCH");
  assertEquals(
    requests[0].url,
    "https://api.github.com/repos/commontoolsinc/labs/issues/comments/1",
  );
  assertEquals(requests[0].body, body);
});

Deno.test("postCoverageComment leaves an up-to-date comment untouched", async () => {
  const body = `${COVERAGE_SUGGESTION_MARKER}\nidentical.`;
  const requests = await runWithPayload(
    { prNumber: 4211, state: "regressed", body },
    [body],
  );

  assertEquals(requests.length, 0);
});

Deno.test("postCoverageComment resolves an existing comment when coverage is acceptable", async () => {
  const existing = [
    COVERAGE_SUGGESTION_MARKER,
    "<details open>",
    "<summary>Test coverage regressed by 3 lines</summary>",
    "",
    "table goes here",
    "",
    "</details>",
  ].join("\n");

  const requests = await runWithPayload(
    { prNumber: 4211, state: "resolved", improvedLines: 5 },
    [existing],
  );

  assertEquals(requests.length, 1);
  assertEquals(requests[0].method, "PATCH");
  assertEquals(
    requests[0].url,
    "https://api.github.com/repos/commontoolsinc/labs/issues/comments/1",
  );
  assertStringIncludes(requests[0].body, "<details>");
  assertStringIncludes(
    requests[0].body,
    "<summary>Code coverage debt reduced by 5 lines!</summary>",
  );
});

Deno.test("postCoverageComment does nothing to resolve when no comment exists", async () => {
  const requests = await runWithPayload(
    { prNumber: 4211, state: "resolved", improvedLines: 5 },
    ["a normal review comment"],
  );

  assertEquals(requests.length, 0);
});

Deno.test("postCoverageComment leaves an already-resolved comment untouched", async () => {
  const existing = [
    COVERAGE_SUGGESTION_MARKER,
    "<details>",
    "<summary>Code coverage regression resolved.</summary>",
    "",
    "</details>",
  ].join("\n");

  const requests = await runWithPayload(
    { prNumber: 4211, state: "resolved", improvedLines: 0 },
    [existing],
  );

  assertEquals(requests.length, 0);
});

Deno.test("postCoverageComment treats a legacy body-only payload as a regression", async () => {
  const body = `${COVERAGE_SUGGESTION_MARKER}\nlegacy comment.`;
  const requests = await runWithPayload({ prNumber: 4211, body }, []);

  assertEquals(requests.length, 1);
  assertEquals(requests[0].method, "POST");
  assertEquals(requests[0].body, body);
});

Deno.test("postCoverageComment skips a regression payload with an empty body", async () => {
  const requests = await runWithPayload(
    { prNumber: 4211, state: "regressed", body: "" },
    [],
  );

  assertEquals(requests.length, 0);
});

Deno.test("postCoverageComment swallows a comment-lookup failure", async () => {
  const requests = await runWithPayload(
    {
      prNumber: 4211,
      state: "regressed",
      body: `${COVERAGE_SUGGESTION_MARKER}\nbody.`,
    },
    [],
    { getStatus: 404 },
  );

  assertEquals(requests.length, 0);
});

Deno.test("postCoverageComment skips an invalid payload without posting", async () => {
  const requests = await runWithPayload({ prNumber: "not-a-number" }, []);
  assertEquals(requests.length, 0);
});
