/**
 * Where the cost of a worker-to-client crossing sits, one step at a time.
 *
 * `ipc-crossing.bench.ts` times the whole round trip, which is what a reader
 * means by "what does a message cost" and is the number to quote. It cannot
 * say which step to work on, because it reports one figure for six walks. This
 * file takes the same payloads and times each walk on its own, so a
 * work-reduction candidate can be picked by size rather than by guess.
 *
 * The six steps, in the order a message meets them:
 *
 * | step | status quo | envelope |
 * | --- | --- | --- |
 * | worker: `convertCellsToLinks()` | yes | yes |
 * | worker: redact carried label views | yes | yes |
 * | worker: encode | -- | yes |
 * | transport | yes | yes |
 * | client: decode | -- | yes |
 * | client: hydrate refs into handles | yes | yes |
 *
 * Each step is timed on an input the previous steps already produced, hoisted
 * out of the timed region. So the figures are the steps' own costs and do not
 * compose into the round trip: what a step hands the next one is built once
 * here and rebuilt every iteration in the real crossing, and the allocation
 * pressure that comes of it lands on whichever step is running.
 *
 * The two client-side steps read an arrival this file built once, so each
 * iteration decodes and hydrates a tree already resident in cache. What they
 * report is therefore a lower bound. Handing each iteration an arrival of its
 * own does not fix that so much as move it: the figure rises with the size of
 * the working set rather than settling anywhere, from 360 us over one tree to
 * 403 over 64 and 438 over 256, on the 1000-record subject. Neither number is
 * what a crossing pays, one message being neither one of many resident trees
 * nor one of hundreds. `ipc-crossing.bench.ts` is what pays the real cost, on
 * a tree `postMessage()` has just written; this file is for ranking the steps
 * against each other and for comparing a change against its base, and a bound
 * that holds on both sides of such a comparison does not disturb it.
 *
 * The transport step is `structuredClone()` rather than a real
 * `postMessage()`, which is a proxy and not the thing: it serializes and
 * deserializes as the crossing does, on the calling thread and without the
 * scheduling that dominates a small message. `ipc-crossing.bench.ts` measures
 * the real one and bounds this.
 *
 * Both flavors of payload are measured, because which one is representative
 * changes over time. A tree carrying no `cfcLabelView` is what crosses today,
 * and the redaction walk over it visits every container to find nothing. A
 * tree carrying one on every link is what crosses once CFC is meaningful, and
 * there the redaction rebuilds the spine as well.
 *
 * Run with:
 *
 *     deno task bench
 */

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { convertCellsToLinks, KeepAsCell } from "@commonfabric/runner";
import {
  type CfcLabelView,
  redactSigilCfcLabelViewsForDisplay,
  setLinkCfcLabelView,
} from "@commonfabric/runner/cfc";

import { CellHandle } from "@/cell-handle.ts";
import { $conn, type RuntimeClient } from "@/runtime-client.ts";

import { readRecordList } from "./fixtures/schema-read.ts";

/** The options the IPC response and notification paths convert under. */
const CONVERT_OPTIONS = {
  includeSchema: true,
  keepAsCell: KeepAsCell.All,
  doNotConvertCellResults: true,
  includeCfcLabelView: true,
} as const;

/**
 * A label view of the shape a link-write policy input carries: one entry, whose
 * confidentiality holds a caveat with a `source` for the redaction to drop.
 */
function makeLabelView(index: number): CfcLabelView {
  return {
    version: 1,
    entries: [{
      path: [],
      label: {
        confidentiality: [{
          type: CFC_ATOM_TYPE.Caveat,
          kind: "benchmark",
          source: { type: CFC_ATOM_TYPE.Builtin, name: `principal-${index}` },
        }],
      },
    }],
  } as CfcLabelView;
}

/**
 * Builds the link that a converted cell becomes, distinct per index, carrying
 * a label view when `labeled`.
 */
function makeLink(index: number, labeled: boolean): FabricValue {
  const link = linkRefFrom({
    id: `of:${"0".repeat(56)}${index.toString(16).padStart(8, "0")}`,
    space: `did:key:z${"a".repeat(47)}`,
    path: ["items", String(index)],
  });

  if (labeled) setLinkCfcLabelView(link as never, makeLabelView(index));

  return link as unknown as FabricValue;
}

/** A list of records, each with a few scalars, a nested array, and one link. */
function makeList(items: number, labeled: boolean): FabricValue {
  const list: FabricValue[] = [];

  for (let i = 0; i < items; i++) {
    list.push({
      title: `item number ${i}`,
      count: i,
      done: (i % 3) === 0,
      tags: [`tag-${i % 7}`, `tag-${i % 11}`],
      source: makeLink(i, labeled),
    });
  }

  return { items: list, total: items, updatedAt: "2026-08-27T00:00:00Z" };
}

/** A flat object of `count` scalar members: one container, many members. */
function makeFlat(count: number): FabricValue {
  const out: Record<string, FabricValue> = {};

  for (let i = 0; i < count; i++) out[`member${i}`] = i;

  return out;
}

/**
 * A handle for the hydration to walk from. `deserialize()` reads its ref, to
 * rebase a relative link, and its client, to hand to a hydrated child -- so a
 * stand-in serves, and building a real `RuntimeClient` here would put a
 * connection this benchmark does not use behind every iteration.
 */
const base = new CellHandle(
  { [$conn]: () => ({}) } as unknown as RuntimeClient,
  {
    id: `of:${"0".repeat(64)}`,
    space: `did:key:z${"a".repeat(47)}`,
    scope: "space",
    path: [],
  },
);

/** One subject: a payload, and what each step of the crossing turns it into. */
type Subject = {
  readonly name: string;
  readonly value: FabricValue;

  /** Whether the payload's links carry a label view. */
  readonly labeled: boolean;
};

const SUBJECTS: readonly Subject[] = [
  { name: "flat 100 members", value: makeFlat(100), labeled: false },
  { name: "100 records", value: makeList(100, false), labeled: false },
  { name: "100 records, labeled", value: makeList(100, true), labeled: true },
  { name: "1000 records", value: makeList(1000, false), labeled: false },
  { name: "1000 records, labeled", value: makeList(1000, true), labeled: true },
  // The read subjects are the same records as a schema-bearing read hands
  // them back, which is what the worker actually converts: every container
  // annotated and frozen, and each `source` a `Cell` rather than a link.
  {
    name: "100 records, read",
    value: await readRecordList(100) as FabricValue,
    labeled: false,
  },
  {
    name: "1000 records, read",
    value: await readRecordList(1000) as FabricValue,
    labeled: false,
  },
];

for (const { name, value, labeled } of SUBJECTS) {
  const converted = convertCellsToLinks(value as never, CONVERT_OPTIONS);
  const redacted = redactSigilCfcLabelViewsForDisplay(converted);
  const encoded = realmFromFabricValue(redacted as FabricValue);

  // What each far side is handed: a message arrives as a clone, never as the
  // object the sender held, and a decode reading a fresh clone is what the
  // crossing does.
  const encodedArrival = structuredClone(encoded);
  const rawArrival = structuredClone(redacted);
  const decoded = fabricFromRealmValue(encodedArrival);

  // A labeled subject whose redaction finds nothing would be a second copy of
  // the labelless one wearing a different name, and would read as a result.
  // Copy-on-write returns the input by reference when no view is found, so
  // identity is the check: it separates the two flavors exactly.
  if ((redacted !== converted) !== labeled) {
    throw new Error(`Fixture is not what it claims: ${name}`);
  }

  Deno.bench({
    name: `convert — ${name}`,
    group: name,
    baseline: true,
  }, () => {
    convertCellsToLinks(value as never, CONVERT_OPTIONS);
  });

  Deno.bench({ name: `redact — ${name}`, group: name }, () => {
    redactSigilCfcLabelViewsForDisplay(converted);
  });

  Deno.bench({ name: `encode — ${name}`, group: name }, () => {
    realmFromFabricValue(redacted as FabricValue);
  });

  Deno.bench({ name: `transport, raw — ${name}`, group: name }, () => {
    structuredClone(redacted);
  });

  Deno.bench({ name: `transport, encoded — ${name}`, group: name }, () => {
    structuredClone(encoded);
  });

  Deno.bench({ name: `decode — ${name}`, group: name }, () => {
    fabricFromRealmValue(encodedArrival);
  });

  Deno.bench({ name: `hydrate, raw — ${name}`, group: name }, () => {
    CellHandle.deserialize(base, rawArrival);
  });

  Deno.bench({ name: `hydrate, decoded — ${name}`, group: name }, () => {
    CellHandle.deserialize(base, decoded);
  });
}
