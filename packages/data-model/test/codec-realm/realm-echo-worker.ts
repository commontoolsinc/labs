// The far side of the boundary this format exists for. It decodes what
// arrives and reports what it got, so that a test can assert on the value as
// reconstructed in a *different realm* rather than in the one that encoded it.
//
// Not a `*.test.ts` file, so the runner does not pick it up as a suite.

import { fabricFromRealmValue } from "@/codecs.ts";
import type { RealmEncodedValue } from "@/codec-realm/interface.ts";

/** What the worker reports back about one decoded value. */
export type EchoReport = {
  /** Whether the decode succeeded. */
  ok: boolean;

  /** The constructor names of the decoded value's own properties, in order. */
  classes?: Record<string, string>;

  /** Assorted facts a structured clone would lose, gathered on this side. */
  facts?: Record<string, unknown>;

  /** The failure message, when `ok` is `false`. */
  error?: string;
};

self.onmessage = (ev: MessageEvent) => {
  try {
    const value = fabricFromRealmValue(ev.data as RealmEncodedValue) as Record<
      string,
      unknown
    >;
    const classes: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      classes[k] = (v === null) ? "null" : (v?.constructor?.name ?? typeof v);
    }
    self.postMessage(
      {
        ok: true,
        classes,
        facts: {
          bytes: (value.bytes as { slice(): Uint8Array } | undefined)
            ? [...(value.bytes as { slice(): Uint8Array }).slice()]
            : undefined,
          nsec: (value.nsec as { value: bigint } | undefined)?.value,
          // Content for every class that carries any, not just the two that
          // happened to be checked first: a class can arrive with the right
          // constructor and the wrong data, and only a value check sees it.
          days: (value.days as { value: bigint } | undefined)?.value,
          hashTag: (value.hash as { tag: string } | undefined)?.tag,
          hashBytes: (value.hash as { bytes: Uint8Array } | undefined)
            ? [...(value.hash as { bytes: Uint8Array }).bytes]
            : undefined,
          regexpParts: (value.regexp as
              | { flavor: string; source: string; flags: string }
              | undefined)
            ? [
              (value.regexp as { flavor: string }).flavor,
              (value.regexp as { source: string }).source,
              (value.regexp as { flags: string }).flags,
            ]
            : undefined,
          holeKeys: Array.isArray(value.sparse)
            ? Object.keys(value.sparse)
            : undefined,
          sparseLength: Array.isArray(value.sparse)
            ? value.sparse.length
            : undefined,
          slashy: (value.plain as Record<string, unknown>)?.["/slashy"],
          negZeroIsNegative: Object.is(value.negZero, -0),
          symbolIsInterned: (typeof value.sym === "symbol") &&
            (Symbol.keyFor(value.sym) === "interned"),
          big: value.big,
          nothingPresent: "nothing" in value,
        },
      } satisfies EchoReport,
    );
  } catch (e) {
    self.postMessage(
      { ok: false, error: (e as Error).message } satisfies EchoReport,
    );
  }
};
