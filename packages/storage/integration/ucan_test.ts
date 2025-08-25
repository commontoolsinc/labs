import { assertEquals } from "@std/assert";
import { createTestApp } from "@/packages/toolshed/lib/create-app.ts";
import storageNew from "@/packages/toolshed/routes/storage/new/new.index.ts";

function b64url(data: string) {
  return btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function makeToken(payload: Record<string, unknown>) {
  const header = { alg: "none", typ: "JWT" };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  // empty signature allowed by our MVP parser
  return `${h}.${p}.`;
}

Deno.test("UCAN: missing auth returns 401 on heads", async () => {
  const app = createTestApp(storageNew);
  const res = await app.request(
    "/api/storage/new/v1/did:space:test/heads/doc1",
  );
  assertEquals(res.status, 401);
});

Deno.test("UCAN: wrong cap returns 403 on heads", async () => {
  const app = createTestApp(storageNew);
  const token = makeToken({
    iss: "did:key:test",
    caps: [{ can: "storage/write", with: "space:did:space:test" }],
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const res = await app.request(
    "/api/storage/new/v1/did:space:test/heads/doc1",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assertEquals(res.status, 403);
});

Deno.test("UCAN: read cap passes auth on heads (then fails due to uninitialized space)", async () => {
  const app = createTestApp(storageNew);
  const token = makeToken({
    iss: "did:key:test",
    caps: [{ can: "storage/read", with: "space:did:space:test" }],
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const res = await app.request(
    "/api/storage/new/v1/did:space:test/heads/doc1",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  // After auth it will attempt storage and fail with 500
  assertEquals(res.status >= 500, true);
});

Deno.test("UCAN: tx requires write cap", async () => {
  const app = createTestApp(storageNew);
  const token = makeToken({
    iss: "did:key:test",
    caps: [{ can: "storage/read", with: "space:did:space:test" }],
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const body = {
    reads: [],
    writes: [],
  };
  const res403 = await app.request(
    "/api/storage/new/v1/did:space:test/tx",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
  );
  assertEquals(res403.status, 403);

  const tokenWrite = makeToken({
    iss: "did:key:test",
    caps: [{ can: "storage/write", with: "space:did:space:test" }],
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const resAuth = await app.request(
    "/api/storage/new/v1/did:space:test/tx",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${tokenWrite}`,
      },
      body: JSON.stringify(body),
    },
  );
  // passes auth, then storage not initialized
  assertEquals(resAuth.status >= 500, true);
});

Deno.test("UCAN: subscribe requires read cap (unauthorized cases)", async () => {
  const app = createTestApp(storageNew);
  const noAuth = await app.request("/api/storage/new/v1/did:space:test/ws");
  assertEquals(noAuth.status, 401);

  const writeOnly = makeToken({
    iss: "did:key:test",
    caps: [{ can: "storage/write", with: "space:did:space:test" }],
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const res403 = await app.request(
    "/api/storage/new/v1/did:space:test/ws",
    { headers: { Authorization: `Bearer ${writeOnly}` } },
  );
  assertEquals(res403.status, 403);
  // Note: we do not test successful WS upgrade here.
});
