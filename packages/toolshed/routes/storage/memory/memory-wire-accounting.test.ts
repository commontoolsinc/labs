import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createTestApp } from "@/lib/create-app.ts";
import { MemoryWireAccountingAccumulator } from "@commonfabric/memory/v2/wire-accounting";
import { createMemoryWireAccountingRouter } from "./memory-wire-accounting-router.ts";

const BASE = "/api/storage/memory/wire-accounting";
const TOKEN = "runner-random-secret";

function appFor(options: {
  accumulator?: MemoryWireAccountingAccumulator;
  token?: string;
  env?: string;
}) {
  return createTestApp(
    createMemoryWireAccountingRouter({
      accumulator: options.accumulator,
      token: options.token ?? TOKEN,
      env: options.env ?? "test",
    }),
  );
}

function auth(token = TOKEN): Headers {
  return new Headers({ authorization: `Bearer ${token}` });
}

async function cancel(res: Response): Promise<void> {
  await res.body?.cancel();
}

describe("memory wire-accounting endpoint", () => {
  it("404s when disabled by missing token", async () => {
    const app = appFor({
      accumulator: new MemoryWireAccountingAccumulator(),
      token: "",
    });
    const res = await app.request(`${BASE}/start`, {
      method: "POST",
      headers: auth(),
    });
    await cancel(res);
    expect(res.status).toBe(404);
  });

  it("404s when disabled by environment even with a token", async () => {
    const app = appFor({
      accumulator: new MemoryWireAccountingAccumulator(),
      env: "production",
    });
    const res = await app.request(`${BASE}/start`, {
      method: "POST",
      headers: auth(),
    });
    await cancel(res);
    expect(res.status).toBe(404);
  });

  it("404s when no accumulator was constructed", async () => {
    const app = appFor({ accumulator: undefined });
    const res = await app.request(`${BASE}/start`, {
      method: "POST",
      headers: auth(),
    });
    await cancel(res);
    expect(res.status).toBe(404);
  });

  it("rejects missing and wrong bearer tokens with 401", async () => {
    const app = appFor({ accumulator: new MemoryWireAccountingAccumulator() });

    const missing = await app.request(`${BASE}/start`, { method: "POST" });
    await cancel(missing);
    expect(missing.status).toBe(401);

    const wrong = await app.request(`${BASE}/start`, {
      method: "POST",
      headers: auth("wrong"),
    });
    await cancel(wrong);
    expect(wrong.status).toBe(401);

    const malformed = await app.request(`${BASE}/start`, {
      method: "POST",
      headers: new Headers({ authorization: TOKEN }),
    });
    await cancel(malformed);
    expect(malformed.status).toBe(401);
  });

  it("start resets and activates, and stop deactivates before returning the report", async () => {
    const accumulator = new MemoryWireAccountingAccumulator();
    const app = appFor({ accumulator });

    accumulator.start();
    accumulator.observe({
      direction: "inbound",
      connectionId: "old",
      metadata: { kind: "runtime" },
      classification: "client.old",
      baselineBytes: 3,
      actualBytes: 5,
    });

    const start = await app.request(`${BASE}/start`, {
      method: "POST",
      headers: auth(),
    });
    expect(start.status).toBe(200);
    await start.json();
    expect(accumulator.isActive()).toBe(true);

    accumulator.observe({
      direction: "outbound",
      connectionId: "current",
      metadata: { kind: "browser", origin: "http://localhost:5173" },
      classification: "server.hello.ok",
      baselineBytes: 7,
      actualBytes: 11,
    });

    const stop = await app.request(`${BASE}/stop`, {
      method: "POST",
      headers: auth(),
    });
    expect(stop.status).toBe(200);
    const report = await stop.json();
    expect(accumulator.isActive()).toBe(false);
    expect(report.totals).toEqual({
      baselineBytes: 7,
      actualBytes: 11,
      frames: 1,
      connections: 1,
    });
    expect(
      report.records.map((record: { connectionId: string }) =>
        record.connectionId
      ),
    )
      .toEqual(["current"]);
    expect(report.byMetadataKind.map((row: { key: string }) => row.key))
      .toEqual([
        "browser",
      ]);
  });

  it("stopped accumulators remain inactive after stop", async () => {
    const accumulator = new MemoryWireAccountingAccumulator();
    const app = appFor({ accumulator });

    const start = await app.request(`${BASE}/start`, {
      method: "POST",
      headers: auth(),
    });
    await start.json();

    const stop = await app.request(`${BASE}/stop`, {
      method: "POST",
      headers: auth(),
    });
    await stop.json();

    accumulator.observe({
      direction: "inbound",
      connectionId: "inactive",
      metadata: { kind: "runtime" },
      classification: "client.watch",
      baselineBytes: 100,
      actualBytes: 100,
    });

    expect(accumulator.snapshot().totals).toEqual({
      baselineBytes: 0,
      actualBytes: 0,
      frames: 0,
      connections: 0,
    });
  });
});
