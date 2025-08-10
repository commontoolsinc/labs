import { DocId, EngineEvent, Version } from "./types.ts";
import { Reader } from "./storage.ts";

export type OutMsg =
  | { id: string; type: "DOC_UPDATE"; docId: DocId; version: Version; doc: any }
  | { id: string; type: "QUERY_SYNCED"; queryId: string; watermark: Version };

export interface Outbox {
  enqueue(clientId: string, msg: OutMsg): void;
  ack(clientId: string, id: string): void;
  drain(clientId: string, onSend: (m: OutMsg) => void): void;
}

export class InMemoryOutbox implements Outbox {
  private q = new Map<string, OutMsg[]>();
  enqueue(clientId: string, msg: OutMsg) {
    if (!this.q.has(clientId)) this.q.set(clientId, []);
    this.q.get(clientId)!.push(msg);
  }
  ack(_clientId: string, _id: string) {}
  drain(clientId: string, onSend: (m: OutMsg) => void) {
    const arr = this.q.get(clientId) || [];
    this.q.set(clientId, []);
    for (const m of arr) onSend(m);
  }
}

export type ClientSendState = {
  sentVersionByDoc: Map<DocId, Version>;
  initialBackfill: Map<string, { watermark: Version; pending: Set<DocId> }>;
};

export class DeliveryManager {
  private clients = new Map<string, ClientSendState>();
  constructor(private storage: Reader, private outbox: Outbox) {}
  private ensureClient(id: string): ClientSendState {
    if (!this.clients.has(id)) {
      this.clients.set(id, {
        sentVersionByDoc: new Map(),
        initialBackfill: new Map(),
      });
    }
    return this.clients.get(id)!;
  }

  startSubscription(
    clientId: string,
    queryId: string,
    touchedDocs: Set<DocId>,
    watermark: Version,
  ) {
    const st = this.ensureClient(clientId);
    const pending = new Set<DocId>();
    st.initialBackfill.set(queryId, { watermark, pending });
    for (const docId of touchedDocs) {
      const snap = this.storage.readDocAtVersion(docId, watermark);
      const last = st.sentVersionByDoc.get(docId);
      if (!last || (snap.version.epoch > (last.epoch || 0))) {
        pending.add(docId);
        this.outbox.enqueue(clientId, {
          id: `mu:${clientId}:${queryId}:${docId}:${snap.version.epoch}`,
          type: "DOC_UPDATE",
          docId,
          version: snap.version,
          doc: snap.doc,
        });
      }
    }
    if (pending.size === 0) {
      this.outbox.enqueue(clientId, {
        id: `qs:${clientId}:${queryId}:${watermark.epoch}`,
        type: "QUERY_SYNCED",
        queryId,
        watermark,
      });
    }
  }

  onAckDoc(clientId: string, docId: DocId, version: Version) {
    const st = this.ensureClient(clientId);
    const prev = st.sentVersionByDoc.get(docId);
    if (!prev || version.epoch > (prev.epoch || 0)) {
      st.sentVersionByDoc.set(docId, version);
    }
    for (const [qid, b] of st.initialBackfill) {
      if (b.pending.delete(docId) && b.pending.size === 0) {
        this.outbox.enqueue(clientId, {
          id: `qs:${clientId}:${qid}:${b.watermark.epoch}`,
          type: "QUERY_SYNCED",
          queryId: qid,
          watermark: b.watermark,
        });
        st.initialBackfill.delete(qid);
      }
    }
  }

  handleEngineEvents(clientId: string, events: EngineEvent[]) {
    const st = this.ensureClient(clientId);
    const docs = new Set<DocId>();
    for (const ev of events) ev.changedDocs.forEach((d) => docs.add(d));
    for (const docId of docs) {
      const snap = this.storage.readDocAtVersion(
        docId,
        this.storage.currentVersion(docId),
      );
      const last = st.sentVersionByDoc.get(docId);
      if (!last || snap.version.epoch > (last.epoch || 0)) {
        this.outbox.enqueue(clientId, {
          id: `mu:${clientId}:live:${docId}:${snap.version.epoch}`,
          type: "DOC_UPDATE",
          docId,
          version: snap.version,
          doc: snap.doc,
        });
      }
    }
  }
}
