/**
 * Executable mini-model of the server-execution v2 identity/commit
 * machinery (docs/specs/server-side-execution/). NON-NORMATIVE: the
 * spec governs; this model exists so schedule-dependent properties
 * (crash windows, cascade interleavings, push filtering) are checked
 * mechanically instead of by hand-enumerated journeys. Scope and
 * simplifications: ../README.md.
 *
 * Modeled, per the rulings through 2026-08-03: commit classes and
 * envelopes (protocol §1), firedAt stamping + actor inheritance
 * (protocol §2, events §2, LT6), same-space cascade carriage (LT1),
 * delegated carriage + stamping (protocol §2b), the wave with
 * splits (serving-loop §3), eventWatermark idempotency (events §4),
 * the crash-lossy process-local outbox (serving-loop §5 — FP1's
 * home), navigateTo's session-connection requirement (LT3), the
 * effect channel enact/ack window (LT8), and scope_key push
 * filtering (protocol §3).
 */

// ---------- identities and keys ----------

export type UserId = string;
export type SessionId = string;
export type SpaceId = string;
export type DocId = string;
export type EventId = string;

/** Acting identity: session absent = sessionless ("server"). */
export interface Acting {
  user?: UserId;
  session?: SessionId;
}

export const SPACE_KEY = "space";
export const userKey = (u: UserId): string => `user:${u}`;
export const sessionKey = (u: UserId, s: SessionId): string =>
  `session:${u}:${s}`;

/** The scope kinds a handler write can declare (scopes.md §2). */
export type ScopeKind = "space" | "user" | "session";

// ---------- the program under test ----------

/** Handler behavior attached to a stream — the model's "pattern". */
export interface HandlerSpec {
  writes: ScopeKind[];
  cascadeTo?: { space: SpaceId; stream: DocId };
  navigate?: boolean;
}

// ---------- world state ----------

export interface StreamEntry {
  seq: number;
  eventId: EventId;
  firedAt: { user?: UserId; session: SessionId | "server" };
  consequenced: boolean;
  /** error-is-the-consequence surface (events §5). */
  error?: string;
}

export interface StreamState {
  handler: HandlerSpec;
  entries: StreamEntry[];
  eventWatermark: number;
}

export interface WriteRow {
  doc: DocId;
  scopeKey: string;
  value: number;
  /** acting identity per action run; absent for runs with none. */
  attribution?: Acting;
}

export interface CommitRecord {
  seq: number;
  class: "authored" | "derived";
  /** "session:<u>:<s>" for client commits; "service:<space>" else. */
  envelope: string;
  holder?: string;
  derivedThrough?: number;
  consequenceOf?: EventId[];
  writes: WriteRow[];
  waveId?: number;
}

export interface Intent {
  nonce: number;
  issuedIn: number;
  target: string;
  acked: boolean;
}

export interface SpaceState {
  seq: number;
  streams: Record<DocId, StreamState>;
  /** `${doc}/${scopeKey}` -> value. */
  docs: Record<string, number>;
  /** sessionKey -> intents (the effects doc's per-session instance). */
  effects: Record<string, Intent[]>;
  W: number;
  commits: CommitRecord[];
  leaseHolder: string | null;
  /** lease tenure counter: bumps at every (re)acquire (model-only
   * audit — lets properties detect a stale-tenure admission). */
  tenure: number;
}

export interface OutboxEntry {
  targetSpace: SpaceId;
  targetStream: DocId;
  eventId: EventId;
  actingPrincipal?: UserId;
  actingSession?: SessionId;
  capabilityRef: string;
}

export interface ServerState {
  alive: boolean;
  /** process-local (serving-loop §5): a crash LOSES it — FP1. */
  outbox: OutboxEntry[];
  /** audit trail of entries destroyed by crashes (model-only). */
  lostAppends: OutboxEntry[];
  /** bumped per genuinely-new process (DR1: holder's process part). */
  processGen: number;
  /** derived commits sealed + sent but not yet admitted — in flight
   * at the store's door, the lease-fencing race's carrier. */
  pendingProbes: Array<{ holder: string; tenure: number }>;
}

export interface ClientSession {
  user: UserId;
  session: SessionId;
  connected: SpaceId[];
  /** overlay record of enacted nonces — reload-WIPED (LT8). */
  enactedNonces: number[];
  /** model-only audit: nonce -> times actually enacted. */
  enactCount: Record<number, number>;
}

export interface World {
  spaces: Record<SpaceId, SpaceState>;
  servers: Record<SpaceId, ServerState>;
  clients: Record<SessionId, ClientSession>;
  /** chain root per event (audit-only; inheritance ground truth). */
  rootOf: Record<EventId, Acting>;
  nextEvent: number;
  nextNonce: number;
  /** spec-breach detections (must stay empty on legal schedules). */
  violations: string[];
  trace: string[];
  /** config: split every wave commit in two (serving-loop §3). */
  splitWaves: boolean;
  /** DR1's in-process discipline: abort in-flight commits BEFORE
   * reacquiring (serving-loop §2's stop-committing MUST). */
  leaseDiscipline: boolean;
  /** admitted derived probes sealed under an ENDED tenure — must
   * stay 0 whenever the discipline is on. */
  staleAdmissions: number;
  /** all admitted probes (audit — also keeps a successful delivery
   * from state-colliding with the pre-seal world in the explorer). */
  admittedProbes: number;
}

// ---------- construction ----------

export interface SpaceSpec {
  streams: Record<DocId, HandlerSpec>;
}

/** DR1: holder = service identity + process-instance component. */
export const holderId = (space: SpaceId, processGen: number): string =>
  `service:${space}#p${processGen}`;

export function makeWorld(opts: {
  spaces: Record<SpaceId, SpaceSpec>;
  clients: Array<{ user: UserId; session: SessionId; connected: SpaceId[] }>;
  splitWaves?: boolean;
  leaseDiscipline?: boolean;
}): World {
  const spaces: Record<SpaceId, SpaceState> = {};
  const servers: Record<SpaceId, ServerState> = {};
  for (const [id, spec] of Object.entries(opts.spaces)) {
    const streams: Record<DocId, StreamState> = {};
    for (const [doc, handler] of Object.entries(spec.streams)) {
      streams[doc] = { handler, entries: [], eventWatermark: 0 };
    }
    spaces[id] = {
      seq: 0,
      streams,
      docs: {},
      effects: {},
      W: 0,
      commits: [],
      leaseHolder: holderId(id, 0),
      tenure: 1,
    };
    servers[id] = {
      alive: true,
      outbox: [],
      lostAppends: [],
      processGen: 0,
      pendingProbes: [],
    };
  }
  const clients: Record<SessionId, ClientSession> = {};
  for (const c of opts.clients) {
    clients[c.session] = {
      user: c.user,
      session: c.session,
      connected: [...c.connected],
      enactedNonces: [],
      enactCount: {},
    };
  }
  return {
    spaces,
    servers,
    clients,
    rootOf: {},
    nextEvent: 1,
    nextNonce: 1,
    violations: [],
    trace: [],
    splitWaves: opts.splitWaves ?? false,
    leaseDiscipline: opts.leaseDiscipline ?? true,
    staleAdmissions: 0,
    admittedProbes: 0,
  };
}

const clone = <T>(x: T): T => structuredClone(x);

// ---------- admission ----------

/** protocol §2 row 2: stamp firedAt from the authenticated envelope. */
function admitClientAppend(
  w: World,
  space: SpaceId,
  stream: DocId,
  client: ClientSession,
): void {
  const sp = w.spaces[space];
  const st = sp.streams[stream];
  sp.seq += 1;
  const eventId = `e${w.nextEvent++}`;
  st.entries.push({
    seq: sp.seq,
    eventId,
    firedAt: { user: client.user, session: client.session },
    consequenced: false,
  });
  w.rootOf[eventId] = { user: client.user, session: client.session };
  sp.commits.push({
    seq: sp.seq,
    class: "authored",
    envelope: sessionKey(client.user, client.session),
    writes: [],
  });
}

/**
 * protocol §2 row 3 + §2b: delegated append — validate the grant,
 * stamp firedAt from the CARRIED acting identity, dedupe by eventId
 * above the target's eventWatermark.
 */
function admitDelegatedAppend(w: World, entry: OutboxEntry): void {
  const sp = w.spaces[entry.targetSpace];
  const st = sp.streams[entry.targetStream];
  const dup = st.entries.some(
    (e) => e.eventId === entry.eventId && e.seq > st.eventWatermark,
  );
  const processed = st.entries.some(
    (e) => e.eventId === entry.eventId && e.seq <= st.eventWatermark,
  );
  if (dup || processed) return; // dedupe horizon / idempotent skip
  sp.seq += 1;
  st.entries.push({
    seq: sp.seq,
    eventId: entry.eventId,
    firedAt: {
      user: entry.actingPrincipal,
      session: entry.actingSession ?? "server",
    },
    consequenced: false,
  });
  sp.commits.push({
    seq: sp.seq,
    class: "authored",
    envelope: `service:src-of-${entry.eventId}`,
    writes: [],
  });
}

/** protocol §2 derived row: the one equality check. Exported for
 * negative tests. Returns true iff admitted. */
export function admitDerived(
  sp: SpaceState,
  commit: { holder?: string; envelope: string },
): boolean {
  return commit.holder !== undefined && commit.holder === sp.leaseHolder &&
    commit.envelope.startsWith("service:");
}

// ---------- the wave (serving-loop §3, events §2) ----------

function runWave(w: World, space: SpaceId): void {
  const sp = w.spaces[space];
  const srv = w.servers[space];
  if (!srv.alive || sp.leaseHolder === null) return;
  const waveId = sp.seq + 1000;
  const writes: WriteRow[] = [];
  const consequenceOf: EventId[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [doc, st] of Object.entries(sp.streams)) {
      for (const entry of st.entries) {
        if (entry.consequenced || entry.seq <= st.eventWatermark) continue;
        progressed = true;
        processEvent(w, space, doc, entry, writes);
        entry.consequenced = true;
        st.eventWatermark = Math.max(st.eventWatermark, entry.seq);
        consequenceOf.push(entry.eventId);
      }
    }
  }
  if (consequenceOf.length === 0 && writes.length === 0) return;
  sp.seq += 1;
  sp.W = sp.seq;
  const base: Omit<CommitRecord, "writes"> = {
    seq: sp.seq,
    class: "derived",
    envelope: `service:${space}`,
    holder: sp.leaseHolder,
    derivedThrough: sp.W,
    consequenceOf: [...consequenceOf],
    waveId,
  };
  if (w.splitWaves && writes.length > 1) {
    const mid = Math.ceil(writes.length / 2);
    // every split repeats derivedThrough AND the full consequenceOf
    // (serving-loop §3, as ruled after the provenance run)
    sp.commits.push({ ...clone(base), writes: writes.slice(0, mid) });
    sp.commits.push({ ...clone(base), writes: writes.slice(mid) });
  } else {
    sp.commits.push({ ...base, writes });
  }
  for (const row of writes) {
    sp.docs[`${row.doc}/${row.scopeKey}`] = row.value;
  }
}

function processEvent(
  w: World,
  space: SpaceId,
  doc: DocId,
  entry: StreamEntry,
  writes: WriteRow[],
): void {
  const sp = w.spaces[space];
  const h = sp.streams[doc].handler;
  const acting: Acting = {
    user: entry.firedAt.user,
    session: entry.firedAt.session === "server"
      ? undefined
      : entry.firedAt.session,
  };
  // consequences land in the acting principal's instances (scopes §5)
  for (const kind of h.writes) {
    if (kind === "space") {
      writes.push({
        doc: `${doc}-out`,
        scopeKey: SPACE_KEY,
        value: entry.seq,
        attribution: acting.user !== undefined ? clone(acting) : undefined,
      });
    } else if (kind === "user") {
      if (acting.user === undefined) {
        entry.error = "user-scoped write with no acting user (events §2)";
        continue;
      }
      writes.push({
        doc: `${doc}-out`,
        scopeKey: userKey(acting.user),
        value: entry.seq,
        attribution: clone(acting),
      });
    } else {
      if (acting.user === undefined || acting.session === undefined) {
        entry.error = "session-scoped write by sessionless actor (scopes §5)";
        continue;
      }
      writes.push({
        doc: `${doc}-out`,
        scopeKey: sessionKey(acting.user, acting.session),
        value: entry.seq,
        attribution: clone(acting),
      });
    }
  }
  // cascade: inheritance, uniform (events §2, LT6)
  if (h.cascadeTo) {
    const eventId = `e${w.nextEvent++}`;
    w.rootOf[eventId] = w.rootOf[entry.eventId] ?? clone(acting);
    if (h.cascadeTo.space === space) {
      // LT1: same-space — a write-level entry in this very wave
      const target = sp.streams[h.cascadeTo.stream];
      sp.seq += 1;
      target.entries.push({
        seq: sp.seq,
        eventId,
        firedAt: clone(entry.firedAt),
        consequenced: false,
      });
    } else {
      // cross-space: outbox, post-commit, at-least-once (§2b)
      w.servers[space].outbox.push({
        targetSpace: h.cascadeTo.space,
        targetStream: h.cascadeTo.stream,
        eventId,
        actingPrincipal: acting.user,
        actingSession: acting.session,
        capabilityRef: `cap:${doc}`,
      });
    }
  }
  // navigateTo: acting session must be CONNECTED to this space (LT3)
  if (h.navigate) {
    if (acting.user === undefined || acting.session === undefined) {
      entry.error = "navigateTo under sessionless actor (builtins §4)";
    } else {
      const client = w.clients[acting.session];
      if (client === undefined || !client.connected.includes(space)) {
        entry.error =
          "cross-space navigateTo: acting session not connected (LT3)";
      } else {
        const key = sessionKey(acting.user, acting.session);
        const list = sp.effects[key] ?? (sp.effects[key] = []);
        list.push({
          nonce: w.nextNonce++,
          issuedIn: sp.seq + 1,
          target: `${space}/${doc}`,
          acked: false,
        });
      }
    }
  }
}

// ---------- push filtering (protocol §3) ----------

export function applicableSet(c: ClientSession): string[] {
  return [SPACE_KEY, userKey(c.user), sessionKey(c.user, c.session)];
}

/** Rows of a commit that a subscriber receives — the filter itself. */
export function pushRowsFor(
  commit: CommitRecord,
  c: ClientSession,
): WriteRow[] {
  const ok = new Set(applicableSet(c));
  return commit.writes.filter((r) => ok.has(r.scopeKey));
}

// ---------- transitions ----------

export type Step =
  | { kind: "fire"; session: SessionId; space: SpaceId; stream: DocId }
  | { kind: "wave"; space: SpaceId }
  | { kind: "deliver"; space: SpaceId }
  | { kind: "crash"; space: SpaceId }
  | { kind: "recover"; space: SpaceId }
  | {
    kind: "derivationEmit";
    space: SpaceId;
    stream: DocId;
    acting: Acting;
  }
  | { kind: "enact"; session: SessionId; space: SpaceId }
  | { kind: "ack"; session: SessionId; space: SpaceId }
  | { kind: "reload"; session: SessionId }
  | { kind: "expireLease"; space: SpaceId }
  | { kind: "reacquire"; space: SpaceId }
  | { kind: "restartProcess"; space: SpaceId }
  | { kind: "sealProbe"; space: SpaceId }
  | { kind: "deliverProbe"; space: SpaceId };

export function apply(w0: World, step: Step): World {
  const w = clone(w0);
  w.trace.push(JSON.stringify(step));
  switch (step.kind) {
    case "fire": {
      const c = w.clients[step.session];
      if (!c.connected.includes(step.space)) {
        w.violations.push("fire without connection");
        break;
      }
      admitClientAppend(w, step.space, step.stream, c);
      break;
    }
    case "wave":
      runWave(w, step.space);
      break;
    case "deliver": {
      const srv = w.servers[step.space];
      if (!srv.alive || srv.outbox.length === 0) break;
      const entry = srv.outbox.shift()!;
      admitDelegatedAppend(w, entry);
      break;
    }
    case "crash": {
      const srv = w.servers[step.space];
      srv.alive = false;
      srv.lostAppends.push(...srv.outbox); // process-local: LOST (FP1)
      srv.outbox = [];
      break;
    }
    case "recover":
      w.servers[step.space].alive = true;
      break;
    case "derivationEmit": {
      // a demanded derivation run emits an event; identity is the
      // demand-supplied instance identity, inherited uniformly (LT6)
      const sp = w.spaces[step.space];
      const st = sp.streams[step.stream];
      sp.seq += 1;
      const eventId = `e${w.nextEvent++}`;
      st.entries.push({
        seq: sp.seq,
        eventId,
        firedAt: {
          user: step.acting.user,
          session: step.acting.session ?? "server",
        },
        consequenced: false,
      });
      w.rootOf[eventId] = clone(step.acting);
      break;
    }
    case "enact": {
      const c = w.clients[step.session];
      const sp = w.spaces[step.space];
      const key = sessionKey(c.user, c.session);
      for (const it of sp.effects[key] ?? []) {
        if (!it.acked && !c.enactedNonces.includes(it.nonce)) {
          c.enactedNonces.push(it.nonce);
          c.enactCount[it.nonce] = (c.enactCount[it.nonce] ?? 0) + 1;
        }
      }
      break;
    }
    case "ack": {
      const c = w.clients[step.session];
      const sp = w.spaces[step.space];
      const key = sessionKey(c.user, c.session);
      for (const it of sp.effects[key] ?? []) {
        if (!it.acked && c.enactedNonces.includes(it.nonce)) it.acked = true;
      }
      break;
    }
    case "reload": {
      // the overlay is process-memory: the enacted-nonce record dies
      // (speculation §1; the LT8-accepted window)
      w.clients[step.session].enactedNonces = [];
      break;
    }
    case "expireLease": {
      // the memory server's clock expires the row: matches NOBODY
      // (protocol §2; serving-loop §2)
      w.spaces[step.space].leaseHolder = null;
      break;
    }
    case "reacquire": {
      // same process, new tenure. DR1: holder value UNCHANGED (the
      // process component is stable within a process lifetime); the
      // discipline aborts in-flight commits BEFORE reacquiring.
      const sp = w.spaces[step.space];
      const srv = w.servers[step.space];
      if (!srv.alive || sp.leaseHolder !== null) break;
      if (w.leaseDiscipline) srv.pendingProbes = [];
      sp.leaseHolder = holderId(step.space, srv.processGen);
      sp.tenure += 1;
      break;
    }
    case "restartProcess": {
      // a genuinely-new process: the holder's process component is
      // fresh (DR1), so the equality check fences the old reign's
      // in-flight commits. The old process's sent commits stay in
      // flight (they are the fence's test subjects).
      const srv = w.servers[step.space];
      srv.processGen += 1;
      srv.alive = true;
      break;
    }
    case "sealProbe": {
      // a derived commit sealed and SENT under the current lease —
      // not yet admitted (in flight at the store's door)
      const sp = w.spaces[step.space];
      const srv = w.servers[step.space];
      if (
        !srv.alive || sp.leaseHolder !== holderId(step.space, srv.processGen)
      ) {
        break;
      }
      srv.pendingProbes.push({ holder: sp.leaseHolder, tenure: sp.tenure });
      break;
    }
    case "deliverProbe": {
      const sp = w.spaces[step.space];
      const srv = w.servers[step.space];
      const probe = srv.pendingProbes.shift();
      if (probe === undefined) break;
      const admitted = admitDerived(sp, {
        holder: probe.holder,
        envelope: `service:${step.space}`,
      });
      if (admitted) {
        w.admittedProbes += 1;
        if (probe.tenure < sp.tenure) w.staleAdmissions += 1;
      }
      break;
    }
  }
  return w;
}

// ---------- schedule exploration ----------

function stableStringify(x: unknown): string {
  return JSON.stringify(x, function (this: unknown, _k, v) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = o[k];
      return out;
    }
    return v;
  });
}

function stateKey(w: World): string {
  const { trace: _t, ...rest } = w;
  return stableStringify(rest);
}

/**
 * Exhaustive DFS over the given step menu, bounded by maxSteps, with
 * visited-state pruning. Deterministic; no clocks, no randomness.
 */
export function explore(
  w0: World,
  menu: Step[],
  opts: { maxSteps: number },
): { finals: World[]; all: World[]; statesSeen: number } {
  const finals: World[] = [];
  const all: World[] = [];
  const visited = new Set<string>();
  const stack: Array<{ w: World; depth: number }> = [{ w: w0, depth: 0 }];
  while (stack.length > 0) {
    const { w, depth } = stack.pop()!;
    const key = stateKey(w);
    if (visited.has(key)) continue;
    visited.add(key);
    all.push(w);
    let extended = false;
    if (depth < opts.maxSteps) {
      for (const step of menu) {
        const next = apply(w, step);
        if (stateKey(next) !== key) {
          extended = true;
          stack.push({ w: next, depth: depth + 1 });
        }
      }
    }
    if (!extended) finals.push(w);
  }
  return { finals, all, statesSeen: visited.size };
}
