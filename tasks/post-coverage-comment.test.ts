import { assertEquals } from "@std/assert";
import * as path from "@std/path";
import { COVERAGE_SUGGESTION_MARKER } from "./perf-lib.ts";
import { postCoverageComment } from "./post-coverage-comment.ts";

interface PostedComment {
  url: string;
  body: string;
}

/**
 * Run postCoverageComment with a payload file and a fetch mock that returns the
 * given existing comments for the GET and records any POST.
 */
async function runWithPayload(
  payload: unknown,
  existingCommentBodies: string[],
): Promise<PostedComment[]> {
  const dir = await Deno.makeTempDir({ prefix: "coverage-comment-test-" });
  const file = path.join(dir, "coverage-comment.json");
  await Deno.writeTextFile(file, JSON.stringify(payload));

  const posted: PostedComment[] = [];
  const originalFetch = globalThis.fetch;
  Deno.env.set("COVERAGE_COMMENT_FILE", file);

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (method === "POST") {
      const parsed = JSON.parse(String(init?.body));
      posted.push({ url, body: parsed.body });
      return Promise.resolve(
        new Response(JSON.stringify({ id: 1 }), { status: 201 }),
      );
    }

    // GET comments — one page, fewer than per_page so pagination stops.
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

  return posted;
}

Deno.test("postCoverageComment posts when no marked comment exists", async () => {
  const body = `${COVERAGE_SUGGESTION_MARKER}\nCover these lines.`;
  const posted = await runWithPayload({ prNumber: 4211, body }, [
    "a normal review comment",
  ]);

  assertEquals(posted.length, 1);
  assertEquals(
    posted[0].url,
    "https://api.github.com/repos/commontoolsinc/labs/issues/4211/comments",
  );
  assertEquals(posted[0].body, body);
});

Deno.test("postCoverageComment skips when a marked comment already exists", async () => {
  const posted = await runWithPayload(
    { prNumber: 4211, body: `${COVERAGE_SUGGESTION_MARKER}\nCover these.` },
    [`${COVERAGE_SUGGESTION_MARKER}\nan earlier run already said this`],
  );

  assertEquals(posted.length, 0);
});

Deno.test("postCoverageComment skips an invalid payload without posting", async () => {
  const posted = await runWithPayload({ prNumber: "not-a-number" }, []);
  assertEquals(posted.length, 0);
});
