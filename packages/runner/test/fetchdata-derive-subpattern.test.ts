// CT-1334: fetchData() + derive() inside sub-pattern causes callback:error
//
// When a sub-pattern combines fetchData() and derive(), and computed() closures
// capture OpaqueRef proxies from the pattern builder scope, the derive
// callback's result is never delivered to the parent pattern. Multiple
// callback:error messages appear and the output stays empty.
//
// Root cause: computed() closures capture OpaqueRef proxies. When the action
// runs, template literals (e.g., `${token}`) trigger Symbol.toPrimitive on
// these proxies, which threw because builder cells have no storage link.
//
// Fix: Make Symbol.toPrimitive on OpaqueRef proxies resolve through the
// action frame's materialize binding, reading the runtime value from the
// pattern's process cell.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createBuilder } from "../src/builder/factory.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { setPatternEnvironment } from "../src/env.ts";

const signer = await Identity.fromPassphrase(
  "test fetchdata-derive-subpattern",
);
const space = signer.did();

describe("CT-1334: fetchData + derive inside sub-pattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let derive: ReturnType<typeof createBuilder>["commontools"]["derive"];
  let computed: ReturnType<typeof createBuilder>["commontools"]["computed"];
  let pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commontools"]["byRef"];
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;
  let errors: Error[];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    tx = runtime.edit();

    const { commontools } = createBuilder();
    ({ derive, computed, pattern, byRef } = commontools);

    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    // Track errors from the scheduler
    errors = [];
    runtime.scheduler.onError((err) => {
      errors.push(err);
    });

    // Mock fetch
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      fetchCalls.push({ url, init });

      await new Promise((resolve) => setTimeout(resolve, 10));

      return new Response(
        JSON.stringify({
          connections: [
            { name: "Alice" },
            { name: "Bob" },
            { name: "Carol" },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("sub-pattern with computed(url) + fetchData + derive delivers result", async () => {
    // This reproduces the CT-1334 bug: a sub-pattern that uses computed()
    // for URL/options, capturing OpaqueRef from pattern inputs. The computed
    // closures capture `token` as an OpaqueRef proxy; without the fix,
    // Symbol.toPrimitive throws when template literals coerce it to a string.
    const fetchData = byRef("fetchData");

    const FetchPage = pattern<{ token: string }>(({ token }) => {
      // computed() captures `token` from the builder scope as an OpaqueRef.
      // The fix makes Symbol.toPrimitive resolve via the frame's materialize
      // binding, so `${token}` works correctly.
      const url = computed(() => {
        if (!token) return "";
        return `http://mock-test-server.local/api/contacts?token=${token}`;
      });

      const options = computed(() => ({
        headers: { Authorization: `Bearer ${token}` },
      }));

      const page = fetchData({ url, options, mode: "json" }) as any;

      return derive(
        {
          pageResult: page.result,
          pageError: page.error,
          pagePending: page.pending,
        },
        ({
          pageResult,
          pageError,
          pagePending,
        }: {
          pageResult: any;
          pageError: any;
          pagePending: boolean;
        }) => {
          if (pagePending || !pageResult) {
            return { contacts: [] as string[], pending: true };
          }
          if (pageError) {
            return { contacts: [] as string[], pending: false };
          }
          const contacts = (pageResult.connections || []).map(
            (c: any) => c.name,
          );
          return { contacts, pending: false };
        },
      );
    });

    // Parent pattern instantiates the sub-pattern
    const Parent = pattern<{ token: string }>(({ token }) => {
      const fetchResult = FetchPage({ token }) as any;
      return {
        contacts: fetchResult.contacts,
        pending: fetchResult.pending,
      };
    });

    const resultCell = runtime.getCell<{
      contacts: string[];
      pending: boolean;
    }>(
      space,
      "ct-1334-computed-fetchdata-derive",
      undefined,
      tx,
    );

    const result = runtime.run(
      tx,
      Parent,
      { token: "test-auth-token-123" },
      resultCell,
    );
    await tx.commit();
    await runtime.storageManager.synced();

    // Wait for computed to settle, fetch to complete, derive to process
    await new Promise((resolve) => setTimeout(resolve, 500));
    const value = await result.pull();

    // No callback:error should have occurred
    expect(errors.length).toBe(0);
    // The derive should have processed fetchData's result
    expect(value.pending).toBe(false);
    expect(value.contacts).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("simple sub-pattern with fetchData + derive (no computed) delivers result", async () => {
    const fetchData = byRef("fetchData");

    const FetchAndTransform = pattern<{ url: string }>(({ url }) => {
      const page = fetchData({ url, mode: "json" }) as any;
      return derive(
        { result: page.result, pending: page.pending },
        ({ result, pending }: { result: any; pending: boolean }) => {
          if (pending || !result) return { data: [], pending: true };
          return { data: result.connections, pending: false };
        },
      );
    });

    // Parent pattern uses the sub-pattern
    const Parent = pattern<{ url: string }>(({ url }) => {
      const fetchResult = FetchAndTransform({ url }) as any;
      return { data: fetchResult.data, pending: fetchResult.pending };
    });

    const resultCell = runtime.getCell<{ data: any[]; pending: boolean }>(
      space,
      "ct-1334-simple-fetchdata-derive",
      undefined,
      tx,
    );

    const result = runtime.run(
      tx,
      Parent,
      { url: "http://mock-test-server.local/api/contacts" },
      resultCell,
    );
    await tx.commit();
    await runtime.storageManager.synced();

    await new Promise((resolve) => setTimeout(resolve, 500));
    const value = await result.pull();

    expect(errors.length).toBe(0);
    expect(value.pending).toBe(false);
    expect(value.data).toEqual([
      { name: "Alice" },
      { name: "Bob" },
      { name: "Carol" },
    ]);
  });

  it("Symbol.toPrimitive still throws outside reactive context", () => {
    // Verify the error still fires when there's no active frame/transaction
    const cell = runtime.getCell<string>(space, "toPrimitive-test", undefined);
    const proxy = (cell as any).getAsOpaqueRefProxy();
    expect(() => `${proxy}`).toThrow(
      "Tried to access a reactive reference outside a reactive context",
    );
  });
});
