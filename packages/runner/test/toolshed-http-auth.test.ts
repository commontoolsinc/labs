import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { sha256 } from "@commonfabric/content-hash";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import {
  FIRST_PARTY_HTTP_AUTH_HEADERS,
  signFirstPartyHttpRequest,
  verifyFirstPartyHttpRequest,
} from "../src/toolshed-http-auth.ts";

const NOW_SECONDS = 1_800_000_000;
const signer = await Identity.fromPassphrase("toolshed http auth test");
const textEncoder = new TextEncoder();

async function signedRequest(
  url: string,
  init: RequestInit = {},
  options: { nowSeconds?: number; validForSeconds?: number } = {},
): Promise<Request> {
  const method = init.method ?? "POST";
  const headers = await signFirstPartyHttpRequest({
    url: new URL(url),
    method,
    headers: init.headers,
    body: init.body,
    signer,
    nowSeconds: options.nowSeconds ?? NOW_SECONDS,
    validForSeconds: options.validForSeconds,
  });
  return new Request(url, { ...init, method, headers });
}

async function expectAuthReject(request: Request): Promise<void> {
  let rejected = false;
  try {
    await verifyFirstPartyHttpRequest({
      request,
      nowSeconds: NOW_SECONDS,
    });
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
}

function expectUnpaddedBase64url(value: string | null): void {
  expect(value).toBeTruthy();
  expect(/^[A-Za-z0-9_-]+$/.test(value!)).toBe(true);
  expect(value).not.toContain("=");
}

describe("first-party toolshed HTTP request proofs", () => {
  it("accepts a POST with a covered body hash", async () => {
    const body = JSON.stringify({ query: "hello" });
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search?q=1",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Signature": "bogus",
          "Signature-Input": "bogus",
          "Content-Digest": "bogus",
        },
        body,
      },
    );

    const verified = await verifyFirstPartyHttpRequest({
      request,
      nowSeconds: NOW_SECONDS,
    });

    expect(verified.userDid).toBe(signer.did());
    expect(request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth))
      .toBeTruthy();
    expectUnpaddedBase64url(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.proof),
    );
    expectUnpaddedBase64url(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256),
    );
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256),
    ).toBe(toUnpaddedBase64url(sha256(textEncoder.encode(body))));
    expect(request.headers.get("Signature")).toBe(null);
    expect(request.headers.get("Signature-Input")).toBe(null);
    expect(request.headers.get("Content-Digest")).toBe(null);
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).toContain("issued-at=");
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).toContain("valid-until=");
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).toContain("proof-did=");
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).toContain("proof-kind=");
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).not.toContain("created=");
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).not.toContain("expires=");
    expect(
      request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth),
    ).not.toContain("alg=");
  });

  it("rejects requests without a proof", async () => {
    await expectAuthReject(
      new Request("http://toolshed.test/api/agent-tools/web-search", {
        method: "POST",
        body: "{}",
      }),
    );
  });

  it("rejects a tampered method", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );

    await expectAuthReject(
      new Request(request.url, {
        method: "PUT",
        headers: request.headers,
        body: "{}",
      }),
    );
  });

  it("rejects a tampered authority", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
    );

    await expectAuthReject(
      new Request("http://other.test/api/agent-tools/web-search", {
        method: "POST",
        headers: request.headers,
        body: "{}",
      }),
    );
  });

  it("rejects a tampered path", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
    );

    await expectAuthReject(
      new Request("http://toolshed.test/api/agent-tools/web-read", {
        method: "POST",
        headers: request.headers,
        body: "{}",
      }),
    );
  });

  it("rejects a tampered query string", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search?x=1",
      {
        method: "POST",
        body: "{}",
      },
    );

    await expectAuthReject(
      new Request("http://toolshed.test/api/agent-tools/web-search?x=2", {
        method: "POST",
        headers: request.headers,
        body: "{}",
      }),
    );
  });

  it("rejects a tampered body hash", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "original" }),
      },
    );

    await expectAuthReject(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({ query: "changed" }),
      }),
    );
  });

  it("rejects a body when the body hash header is missing", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
    );
    const headers = new Headers(request.headers);
    headers.delete(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256);

    await expectAuthReject(
      new Request(request.url, {
        method: "POST",
        headers,
        body: "{}",
      }),
    );
  });

  it("rejects padded proof values", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
    );
    const headers = new Headers(request.headers);
    headers.set(
      FIRST_PARTY_HTTP_AUTH_HEADERS.proof,
      `${headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.proof)}=`,
    );

    await expectAuthReject(
      new Request(request.url, {
        method: "POST",
        headers,
        body: "{}",
      }),
    );
  });

  it("rejects expired proofs", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
      { nowSeconds: NOW_SECONDS - 120 },
    );

    await expectAuthReject(request);
  });

  it("rejects proofs issued too far in the future", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
      { nowSeconds: NOW_SECONDS + 120 },
    );

    await expectAuthReject(request);
  });

  it("rejects a replay across a different protected route", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/sandbox/exec",
      {
        method: "POST",
        body: "{}",
      },
    );

    await expectAuthReject(
      new Request("http://toolshed.test/api/agent-tools/web-search", {
        method: "POST",
        headers: request.headers,
        body: "{}",
      }),
    );
  });

  it("rejects proofs with excessive lifetime", async () => {
    const request = await signedRequest(
      "http://toolshed.test/api/agent-tools/web-search",
      {
        method: "POST",
        body: "{}",
      },
      { validForSeconds: 600 },
    );

    await expectAuthReject(request);
  });
});
