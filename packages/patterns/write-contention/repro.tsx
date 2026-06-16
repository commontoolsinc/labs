/// <cts-enable />
/**
 * Minimal write-contention repro — NO SQLite.
 *
 * The lunch-poll work showed concurrent shared-state writes are silently dropped
 * under contention, and that it is NOT SQLite-specific (a keyed cell variant
 * dropped 18/30 at 10 users). This pattern strips away ALL lunch-poll baggage to
 * study the GENERAL mechanism on plain `PerSpace` cells.
 *
 * Two write paths, so a multi-runtime driver can A/B them under identical
 * concurrency:
 *   - `append(marker)`        -> list.push(marker)          SHARED-LEAF read-modify-write
 *                                                            (models the array `votes.push`)
 *   - `setKey({id, marker})`  -> map.key(id).set(marker)    DISTINCT-KEY write
 *                                                            (models keyed/indexed `.key().set()`)
 *
 * Each runtime writes UNIQUE markers, so a cold reader of canonical storage can
 * name exactly WHICH writes landed vs vanished — and whether distinct-key writes
 * drop as badly as shared-list writes (the coarse- vs fine-grained-conflict
 * question raised by Phase 3, where keyed `indexed` contended identically to the
 * shared-list `array`).
 */

import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  type PerSpace,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

type MarkerList = string[];
type MarkerMap = Record<string, string>;

const EMPTY_LIST: MarkerList = [];
const EMPTY_MAP: MarkerMap = {};

type ListCell = Writable<MarkerList | Default<typeof EMPTY_LIST>>;
type MapCell = Writable<MarkerMap | Default<typeof EMPTY_MAP>>;

export interface AppendEvent {
  marker?: string;
}
export interface SetKeyEvent {
  id?: string;
  marker?: string;
}

// SHARED-LEAF read-modify-write: every runtime pushes onto ONE list cell.
const append = handler<AppendEvent, { list: ListCell }>(
  ({ marker }, { list }) => {
    if (!marker) return;
    list.push(marker);
  },
);

// DISTINCT-KEY write: every runtime writes its OWN key in a shared map.
const setKey = handler<SetKeyEvent, { map: MapCell }>(
  ({ id, marker }, { map }) => {
    if (!id || !marker) return;
    map.key(id).set(marker);
  },
);

// SECOND INDEPENDENT shared-list cell, disjoint from `list`. For the space-level
// granularity test: if writers pushing ONLY `listB` raise the drop rate of a
// disjoint writer group pushing ONLY `list`, the serialization unit is broader
// than the document (independent cells in one space collide).
const appendB = handler<AppendEvent, { listB: ListCell }>(
  ({ marker }, { listB }) => {
    if (!marker) return;
    listB.push(marker);
  },
);

export interface ContentionInput {
  list?: PerSpace<MarkerList | Default<typeof EMPTY_LIST>>;
  listB?: PerSpace<MarkerList | Default<typeof EMPTY_LIST>>;
  map?: PerSpace<MarkerMap | Default<typeof EMPTY_MAP>>;
}

export interface ContentionOutput {
  [NAME]: string;
  [UI]: VNode;
  list: readonly string[];
  listB: readonly string[];
  mapKeys: readonly string[];
  listCount: number;
  listBCount: number;
  mapCount: number;
  append: Stream<AppendEvent>;
  appendB: Stream<AppendEvent>;
  setKey: Stream<SetKeyEvent>;
}

export default pattern<ContentionInput, ContentionOutput>(
  ({ list, listB, map }) => {
    const listSnapshot = computed(() => list ?? EMPTY_LIST);
    const listBSnapshot = computed(() => listB ?? EMPTY_LIST);
    const mapKeys = computed(() => Object.keys(map ?? EMPTY_MAP));
    const listCount = computed(() => (list ?? EMPTY_LIST).length);
    const listBCount = computed(() => (listB ?? EMPTY_LIST).length);
    const mapCount = computed(() => Object.keys(map ?? EMPTY_MAP).length);

    return {
      [NAME]: "write-contention repro",
      [UI]: (
        <div>
          list={listCount} · listB={listBCount} · map={mapCount}
        </div>
      ),
      list: listSnapshot,
      listB: listBSnapshot,
      mapKeys,
      listCount,
      listBCount,
      mapCount,
      append: append({ list }),
      appendB: appendB({ listB }),
      setKey: setKey({ map }),
    };
  },
);
