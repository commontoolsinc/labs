import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  IStorageManager,
  IStorageSubscription,
} from "../src/storage/interface.ts";
import { NewStorageManager } from "../src/storage-new/manager.ts";
import { docIdFromUri } from "../src/storage-new/address.ts";

describe("storage-new/manager", () => {
  it("bridges client onChange into integrate notifications", () => {
    const notifications: any[] = [];
    const delegate: IStorageManager = {
      id: "legacy",
      open: () => ({}) as any,
      edit: () =>
        ({
          get journal() {
            return {} as any;
          },
          status: () => ({ status: "ready", journal: {} as any }),
          reader: () => ({ ok: {} } as any),
          writer: () => ({ ok: {} } as any),
          read: () => ({ ok: { address: {} as any, value: undefined } } as any),
          write:
            () => ({ ok: { address: {} as any, value: undefined } } as any),
          abort: () => ({ ok: {} } as any),
          commit: async () => ({ ok: {} } as any),
        }) as any,
      subscribe(sub: IStorageSubscription) {
        // Pipe delegate notifications into our list to ensure forwarding still works
        // (Manager forwards delegate notifications as-is)
        // We won't emit here, test focuses on client bridge below.
      },
      synced: () => Promise.resolve(),
    };

    // Fake client used by NewStorageManager internally: we'll swap its onChange handler after construction
    // Inject a fake client via options to capture onChange hook
    let changeHandler: ((e: any) => void) | undefined;
    const fakeClient = {
      onChange(cb: (e: any) => void) {
        changeHandler = cb;
        return () => {};
      },
      synced: () => Promise.resolve(),
    } as any;
    const mgr = new NewStorageManager(delegate, {
      apiUrl: new URL("http://localhost:0"),
      client: fakeClient,
    } as any);
    const captured: any[] = [];
    mgr.subscribe({
      next(n) {
        captured.push(n);
        return undefined;
      },
    });

    // Simulate a server deliver event
    changeHandler?.({
      space: "did:key:z6Mktest",
      docId: docIdFromUri("of:abc"),
      path: [],
      before: { x: 1 },
      after: { x: 2 },
    });

    // Verify a single integrate notification with expected shape
    expect(captured.length).toBe(1);
    const note = captured[0];
    expect(note.type).toBe("integrate");
    expect(note.space).toBe("did:key:z6Mktest");
    const entries = Array.from(note.changes) as Array<{
      address: { id: string; type: string; path: string[] };
      before: unknown;
      after: unknown;
    }>;
    expect(entries.length).toBe(1);
    expect(entries[0].address.id).toBe("of:abc");
    expect(entries[0].address.type).toBe("application/json");
    expect(entries[0].address.path).toEqual([]);
    expect(entries[0].before).toEqual({ x: 1 });
    expect(entries[0].after).toEqual({ x: 2 });
  });
});
