import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  FIRST_PARTY_HTTP_AUTH_HEADERS,
  verifyFirstPartyHttpRequest,
} from "@commonfabric/runner/toolshed-http-auth";
import {
  PatternIndexClient,
  PatternIndexError,
} from "../../src/pattern-index/client.ts";
import type { HarnessFetch } from "../../src/contracts/http-fetch.ts";

const signer = await Identity.fromPassphrase("cf-harness pattern-index client");

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/**
 * A fetch that records what it was asked for and answers with `responses` in
 * order. No network is involved, so what the client sends is observable
 * exactly as it composed it.
 */
const recordingFetch = (
  responses: readonly Response[],
): { fetchFn: HarnessFetch; requests: RecordedRequest[] } => {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const fetchFn: HarnessFetch = (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    const response = responses[index];
    index += 1;
    return Promise.resolve(response);
  };
  return { fetchFn, requests };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const createClient = (
  responses: readonly Response[],
  baseUrl = "https://index.test/api",
) => {
  const { fetchFn, requests } = recordingFetch(responses);
  return {
    client: new PatternIndexClient({ baseUrl, fetchFn, signer }),
    requests,
  };
};

describe("PatternIndexClient", () => {
  it("refuses a base URL carrying a query or fragment", () => {
    for (
      const baseUrl of [
        "https://index.test/api?x=1",
        "https://index.test/api#frag",
      ]
    ) {
      expect(() =>
        new PatternIndexClient({
          baseUrl,
          fetchFn: () => Promise.resolve(jsonResponse({})),
          signer,
        })
      ).toThrow("query or fragment");
    }
  });

  it("joins functions onto the parsed base, so a bare trailing delimiter cannot survive", async () => {
    // "https://index.test/api?" parses to an empty search the guard cannot
    // see; appending to the raw string would address "…api?/searchPatterns".
    const { client, requests } = createClient(
      [jsonResponse({ results: [] })],
      "https://index.test/api?",
    );
    await client.searchPatterns({ tags: ["todo"] });
    expect(requests[0].url).toBe("https://index.test/api/searchPatterns");
  });

  it("posts a signed CF1 request to the named index function", async () => {
    const { client, requests } = createClient([
      jsonResponse({ results: [] }),
    ]);
    await client.searchPatterns({ tags: ["todo"] });
    expect(requests.length).toBe(1);
    const request = requests[0];
    expect(request.method).toBe("POST");
    expect(request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.userDid))
      .toBe(signer.did());
    expect(request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth)).toContain(
      "CF1",
    );
    expect(request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.proof))
      .toBeTruthy();
    expect(request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256))
      .toBeTruthy();
    expect(request.headers.get("Content-Type")).toBe("application/json");
  });

  it("signs what it sends, as the index's own verifier reads it", async () => {
    const { client, requests } = createClient([jsonResponse({ results: [] })]);
    await client.searchPatterns({ tags: ["todo"], text: "expenses" });
    // Reconstructed from exactly what the fetch was handed, and verified with
    // the function the index runs on the receiving side: the proof commits to
    // the body hash, so a client that signed one set of bytes and sent
    // another fails here rather than at the deployment.
    const request = requests[0];
    const verified = await verifyFirstPartyHttpRequest({
      request: new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }),
    });
    expect(verified.userDid).toBe(signer.did());
  });

  it("keeps every segment of a base URL served under a path prefix", async () => {
    const { client, requests } = createClient([jsonResponse({ results: [] })]);
    await client.searchPatterns({ text: "expenses" });
    expect(requests[0].url).toBe("https://index.test/api/searchPatterns");
  });

  it("sends only the search fields the caller supplied", async () => {
    const { client, requests } = createClient([jsonResponse({ results: [] })]);
    await client.searchPatterns({ text: "expenses", limit: 5 });
    expect(JSON.parse(requests[0].body)).toEqual({
      text: "expenses",
      limit: 5,
    });
  });

  it("answers searchPatterns with the index's results", async () => {
    const { client } = createClient([
      jsonResponse({
        results: [{
          patternId: "pat-1",
          description: "Totals an expense list",
          hashtags: ["expenses"],
          ownerDid: "did:key:zOwner",
          createdAt: "2026-08-01T00:00:00.000Z",
          dependencies: [],
          signals: { uses: 4, score: 0.75 },
        }],
      }),
    ]);
    const response = await client.searchPatterns({ tags: ["expenses"] });
    expect(response.results.length).toBe(1);
    expect(response.results[0].patternId).toBe("pat-1");
    expect(response.results[0].signals).toEqual({ uses: 4, score: 0.75 });
  });

  it("asks getPattern for source only when told to", async () => {
    const { client, requests } = createClient([
      jsonResponse({
        patternId: "pat-1",
        ownerDid: "did:key:zOwner",
        createdAt: "2026-08-01T00:00:00.000Z",
        description: "Totals an expense list",
        hashtags: ["expenses"],
        dependencies: [],
        program: {
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: "export default 1;" }],
        },
      }),
    ]);
    const pattern = await client.getPattern({
      patternId: "pat-1",
      includeSource: true,
    });
    expect(requests[0].url).toBe("https://index.test/api/getPattern");
    expect(JSON.parse(requests[0].body)).toEqual({
      patternId: "pat-1",
      includeSource: true,
    });
    expect(pattern.program?.files[0].contents).toBe("export default 1;");
  });

  it("asks getPattern for no source when the caller omits the flag", async () => {
    const { client, requests } = createClient([
      jsonResponse({
        patternId: "pat-1",
        ownerDid: "did:key:zOwner",
        createdAt: "2026-08-01T00:00:00.000Z",
        description: "Totals an expense list",
        hashtags: ["expenses"],
        dependencies: [],
      }),
    ]);
    const pattern = await client.getPattern({ patternId: "pat-1" });
    expect(JSON.parse(requests[0].body)).toEqual({ patternId: "pat-1" });
    expect(pattern.program).toBeUndefined();
  });

  it("posts an event with its type and optional note", async () => {
    const { client, requests } = createClient([jsonResponse({ ok: true })]);
    const response = await client.recordEvent({
      patternId: "pat-1",
      eventType: "run_succeeded",
      note: "ran in the harness",
    });
    expect(requests[0].url).toBe("https://index.test/api/recordEvent");
    expect(JSON.parse(requests[0].body)).toEqual({
      patternId: "pat-1",
      eventType: "run_succeeded",
      note: "ran in the harness",
    });
    expect(response.ok).toBe(true);
  });

  it("posts a publication with its program and declared shapes", async () => {
    const { client, requests } = createClient([
      jsonResponse({ patternId: "pat-2", created: true }),
    ]);
    const response = await client.publishPattern({
      patternId: "pat-2",
      description: "Doubles a number",
      directQuery: "double a number",
      hashtags: ["math"],
      program: {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "export default 1;" }],
      },
      resultSchema: { type: "object" },
    });
    expect(requests[0].url).toBe("https://index.test/api/publishPattern");
    expect(JSON.parse(requests[0].body)).toEqual({
      patternId: "pat-2",
      program: {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "export default 1;" }],
      },
      meta: {
        directQuery: "double a number",
        description: "Doubles a number",
        hashtags: ["math"],
      },
      schemas: { resultSchema: { type: "object" } },
    });
    expect(response.patternId).toBe("pat-2");
    expect(response.created).toBe(true);
  });

  it("throws a typed error carrying the status and the index's message", async () => {
    const { client } = createClient([
      jsonResponse({ error: "unknown pattern" }, 404),
    ]);
    const error = await client.getPattern({ patternId: "missing" })
      .then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PatternIndexError);
    expect((error as PatternIndexError).status).toBe(404);
    expect((error as PatternIndexError).fn).toBe("getPattern");
    // The service body stays off `message` — error paths render `message`
    // toward the model, and a failure body can quote indexed source.
    expect((error as PatternIndexError).message).toBe(
      "pattern index getPattern failed (404)",
    );
    expect((error as PatternIndexError).detail).toContain("unknown pattern");
  });

  it("throws rather than answering when a 2xx body does not parse", async () => {
    const { client } = createClient([
      new Response("not json", { status: 200 }),
    ]);
    const error = await client.searchPatterns({ text: "x" })
      .then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PatternIndexError);
    expect((error as PatternIndexError).detail).toContain("not JSON");
  });
});
