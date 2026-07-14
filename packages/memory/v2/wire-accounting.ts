import type { ClientMessage, ServerMessage } from "../v2.ts";

export type MemoryWireDirection = "inbound" | "outbound";

export interface MemoryWireConnectionMetadata {
  kind?: string;
  [key: string]: unknown;
}

export interface MemoryWireAccountingRecord {
  direction: MemoryWireDirection;
  connectionId: string;
  metadata?: MemoryWireConnectionMetadata;
  classification: string;
  baselineBytes: number;
  actualBytes: number;
}

export interface MemoryWireAccountingObserver {
  isActive?(): boolean;
  observe(record: MemoryWireAccountingRecord): void;
}

export interface MemoryWireAccountingTotals {
  baselineBytes: number;
  actualBytes: number;
  frames: number;
  connections: number;
}

export interface MemoryWireAccountingRow extends MemoryWireAccountingTotals {
  key: string;
}

export interface MemoryWireAccountingReport {
  totals: MemoryWireAccountingTotals;
  byDirection: MemoryWireAccountingRow[];
  byConnection: MemoryWireAccountingRow[];
  byMetadataKind: MemoryWireAccountingRow[];
  byClassification: MemoryWireAccountingRow[];
  records: MemoryWireAccountingRecord[];
}

type MutableTotals = {
  baselineBytes: number;
  actualBytes: number;
  frames: number;
  connections: Set<string>;
};

const textEncoder = new TextEncoder();

export const memoryWireUtf8Bytes = (payload: string): number =>
  textEncoder.encode(payload).byteLength;

export const classifyClientMessage = (
  message: ClientMessage | null,
): string => message === null ? "client.invalid" : `client.${message.type}`;

export const classifyServerMessage = (
  message: ServerMessage,
  originatingRequestType?: string,
): string => {
  switch (message.type) {
    case "hello.ok":
      return "server.hello.ok";
    case "session/effect":
      return "server.session/effect.sync";
    case "session/revoked":
      return "server.session/revoked";
    case "response": {
      const origin = originatingRequestType ?? "unknown";
      const suffix = responseCarriesSync(message)
        ? ".sync"
        : message.error !== undefined
        ? ".error"
        : "";
      return `server.response.${origin}${suffix}`;
    }
  }
};

const responseCarriesSync = (message: ServerMessage): boolean => {
  if (message.type !== "response" || message.ok === undefined) {
    return false;
  }
  const ok = message.ok;
  return ok !== null && typeof ok === "object" &&
    (ok as { sync?: { type?: unknown } }).sync?.type === "sync";
};

const emptyTotals = (): MutableTotals => ({
  baselineBytes: 0,
  actualBytes: 0,
  frames: 0,
  connections: new Set(),
});

const addToTotals = (
  totals: MutableTotals,
  record: MemoryWireAccountingRecord,
): void => {
  totals.baselineBytes += record.baselineBytes;
  totals.actualBytes += record.actualBytes;
  totals.frames += 1;
  totals.connections.add(record.connectionId);
};

const snapshotTotals = (
  totals: MutableTotals,
): MemoryWireAccountingTotals => ({
  baselineBytes: totals.baselineBytes,
  actualBytes: totals.actualBytes,
  frames: totals.frames,
  connections: totals.connections.size,
});

const addGrouped = (
  groups: Map<string, MutableTotals>,
  key: string,
  record: MemoryWireAccountingRecord,
): void => {
  let totals = groups.get(key);
  if (totals === undefined) {
    totals = emptyTotals();
    groups.set(key, totals);
  }
  addToTotals(totals, record);
};

const snapshotRows = (
  groups: Map<string, MutableTotals>,
): MemoryWireAccountingRow[] =>
  [...groups.entries()].map(([key, totals]) => ({
    key,
    ...snapshotTotals(totals),
  }));

export class MemoryWireAccountingAccumulator
  implements MemoryWireAccountingObserver {
  #active = false;
  #records: MemoryWireAccountingRecord[] = [];

  isActive(): boolean {
    return this.#active;
  }

  start(): void {
    this.reset();
    this.#active = true;
  }

  reset(): void {
    this.#records = [];
  }

  stop(): MemoryWireAccountingReport {
    this.#active = false;
    return this.snapshot();
  }

  snapshot(): MemoryWireAccountingReport {
    const totals = emptyTotals();
    const byDirection = new Map<string, MutableTotals>();
    const byConnection = new Map<string, MutableTotals>();
    const byMetadataKind = new Map<string, MutableTotals>();
    const byClassification = new Map<string, MutableTotals>();

    for (const record of this.#records) {
      addToTotals(totals, record);
      addGrouped(byDirection, record.direction, record);
      addGrouped(byConnection, record.connectionId, record);
      addGrouped(byMetadataKind, record.metadata?.kind ?? "unknown", record);
      addGrouped(byClassification, record.classification, record);
    }

    return {
      totals: snapshotTotals(totals),
      byDirection: snapshotRows(byDirection),
      byConnection: snapshotRows(byConnection),
      byMetadataKind: snapshotRows(byMetadataKind),
      byClassification: snapshotRows(byClassification),
      records: this.#records.map((record) => ({ ...record })),
    };
  }

  observe(record: MemoryWireAccountingRecord): void {
    if (!this.#active) {
      return;
    }
    this.#records.push({
      ...record,
      metadata: record.metadata === undefined ? undefined : {
        ...record.metadata,
      },
    });
  }
}
