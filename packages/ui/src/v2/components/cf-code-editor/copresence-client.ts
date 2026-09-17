/**
 * Strict protocol validation and latest-value WebSocket transport for editor
 * co-presence.
 *
 * @module
 */

import {
  MAX_PRESENCE_PARTICIPANTS,
  type ParticipantPresence,
  type PresenceCursor,
} from "./codemirror-presence.ts";
import { hashStringOf } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/utils/types";

const protocolVersion = 1;
const roomPattern = /^[A-Za-z0-9_-]{22,128}$/;
const participantIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maximumNameCodePoints = 80;
const maximumNameBytes = 256;
const maximumSelectionRanges = 16;
const maximumPosition = 2_147_483_647;
const maximumUpsertMessageBytes = 8 * 1024;
const maximumServerMessageBytes = 2 * 1024 * 1024;
const openSocketState = 1;

type PresenceSelection = ParticipantPresence["selection"];

/** Failure categories safe to expose without room or participant data. */
export type PresenceFailureCategory =
  | "configuration"
  | "connection"
  | "protocol";

/** Latest local state eligible for replacement publication. */
export type PresencePublication = {
  /** Plain-text participant label. */
  name: string;

  /** Whether the editor currently owns browser focus. */
  focused: boolean;

  /** Confirmed Memory coordinate used by the selection. */
  cursor: PresenceCursor;

  /** Selection in confirmed coordinates, or `null` until one is established. */
  selection: PresenceSelection;

  /** Whether local pending changes were involved in deriving the selection. */
  basis: ParticipantPresence["basis"];
};

/** Initial server view of every other live room participant. */
export type PresenceSnapshot = {
  /** Participant id assigned to this WebSocket by the room. */
  selfParticipantId: string;

  /** Latest states for the room's other live participants. */
  participants: ParticipantPresence[];
};

/** Strictly decoded server-to-editor message. */
export type PresenceServerMessage =
  | { type: "room.snapshot"; snapshot: PresenceSnapshot }
  | { type: "participant.upsert"; participant: ParticipantPresence }
  | { type: "participant.remove"; participantId: string };

/** Browser WebSocket surface used by the session and deterministic tests. */
export interface PresenceSocket {
  /** Current WebSocket ready-state value. */
  readonly readyState: number;

  /** Sends one UTF-8 JSON protocol frame. */
  send(data: string): void;

  /** Closes the socket with an optional protocol code and public reason. */
  close(code?: number, reason?: string): void;

  /**
   * Registers a listener for one socket event, typed to the event that name
   * carries.
   */
  // Open.
  addEventListener(type: "open", listener: (event: Event) => void): void;
  // Message.
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  // Error.
  addEventListener(type: "error", listener: (event: Event) => void): void;
  // Close.
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
}

/** Transport and observer dependencies for one room session. */
export type CopresenceSessionOptions = {
  /** WebSocket origin or base URL for the co-presence service. */
  serviceUrl: string;

  /** Opaque high-entropy room identifier. */
  room: string;

  /** Optional WebSocket factory used by tests and alternate browser hosts. */
  createSocket?: (url: string) => PresenceSocket;

  /** Optional animation-frame scheduler used to coalesce publications. */
  scheduleFrame?: (callback: FrameRequestCallback) => number;

  /** Cancels a frame scheduled through `scheduleFrame`. */
  cancelFrame?: (handle: number) => void;

  /** Receives one strictly validated server message. */
  onMessage: (message: PresenceServerMessage) => void;

  /** Receives the first terminal failure category for this session. */
  onFailure: (category: PresenceFailureCategory) => void;
};

/** Canonical resolved operation-field identity used for room rendezvous. */
export type CopresenceFieldIdentity = {
  space: string;
  branch: string;
  id: string;
  scopeKey: string;
  path: readonly string[];
};

/** Derives an opaque room from one resolved, pinned Memory field. */
export function copresenceRoomForField(
  field: CopresenceFieldIdentity,
): string {
  return hashStringOf({
    namespace: "cf-code-editor-copresence-room",
    version: 1,
    space: field.space,
    branch: field.branch,
    id: field.id,
    scopeKey: field.scopeKey,
    path: [...field.path],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObjectNotArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSelectionAssociation(value: unknown): value is -1 | 0 | 1 {
  return value === -1 || value === 0 || value === 1;
}

function hasInvalidNameCodePoint(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff);
  });
}

function decodeCursor(value: unknown): PresenceCursor {
  if (
    !isRecord(value) || !hasExactKeys(value, ["epoch", "version"]) ||
    !isNonnegativeSafeInteger(value.epoch) ||
    !isNonnegativeSafeInteger(value.version) || value.epoch > maximumPosition ||
    value.version > maximumPosition
  ) {
    throw new Error("Presence cursor is invalid");
  }
  return { epoch: value.epoch, version: value.version };
}

function decodeName(value: unknown): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.trim().length === 0 || hasInvalidNameCodePoint(value) ||
    [...value].length > maximumNameCodePoints ||
    new TextEncoder().encode(value).length > maximumNameBytes
  ) {
    throw new Error("Presence participant name is invalid");
  }
  return value;
}

function decodeParticipantId(value: unknown): string {
  if (typeof value !== "string" || !participantIdPattern.test(value)) {
    throw new Error("Presence participant id is invalid");
  }
  return value;
}

function decodeSelection(value: unknown): PresenceSelection {
  if (value === null) return null;
  if (
    !isRecord(value) || !hasExactKeys(value, ["main", "ranges"]) ||
    !Array.isArray(value.ranges) || value.ranges.length === 0 ||
    value.ranges.length > maximumSelectionRanges ||
    !isNonnegativeSafeInteger(value.main) || value.main >= value.ranges.length
  ) {
    throw new Error("Presence selection is invalid");
  }
  const ranges = value.ranges.map((range) => {
    if (
      !isRecord(range) ||
      !hasExactKeys(range, ["anchor", "head", "assoc"]) ||
      !isNonnegativeSafeInteger(range.anchor) ||
      !isNonnegativeSafeInteger(range.head) || range.anchor > maximumPosition ||
      range.head > maximumPosition ||
      !isSelectionAssociation(range.assoc)
    ) {
      throw new Error("Presence selection range is invalid");
    }
    return { anchor: range.anchor, head: range.head, assoc: range.assoc };
  });
  return { ranges, main: value.main };
}

function decodeParticipant(value: unknown): ParticipantPresence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "participantId",
      "revision",
      "name",
      "focused",
      "cursor",
      "selection",
      "basis",
    ]) ||
    !isNonnegativeSafeInteger(value.revision) || value.revision < 1 ||
    typeof value.focused !== "boolean" ||
    (value.focused && value.selection === null) ||
    (value.basis !== "provisional" && value.basis !== "confirmed")
  ) {
    throw new Error("Presence participant record is invalid");
  }
  return {
    participantId: decodeParticipantId(value.participantId),
    revision: value.revision,
    name: decodeName(value.name),
    focused: value.focused,
    cursor: decodeCursor(value.cursor),
    selection: decodeSelection(value.selection),
    basis: value.basis,
  };
}

/** Strictly decodes one server-to-editor presence message. */
export function decodePresenceServerMessage(
  value: unknown,
): PresenceServerMessage {
  if (!isRecord(value) || value.v !== protocolVersion) {
    throw new Error("Presence protocol version is invalid");
  }
  if (value.type === "participant.upsert") {
    if (
      !hasExactKeys(value, [
        "v",
        "type",
        "participantId",
        "revision",
        "name",
        "focused",
        "cursor",
        "selection",
        "basis",
      ])
    ) {
      throw new Error("Presence upsert message is invalid");
    }
    const { v: _v, type: _type, ...record } = value;
    return {
      type: "participant.upsert",
      participant: decodeParticipant(record),
    };
  }
  if (value.type === "participant.remove") {
    if (!hasExactKeys(value, ["v", "type", "participantId"])) {
      throw new Error("Presence removal message is invalid");
    }
    return {
      type: "participant.remove",
      participantId: decodeParticipantId(value.participantId),
    };
  }
  if (value.type === "room.snapshot") {
    if (
      !hasExactKeys(value, [
        "v",
        "type",
        "selfParticipantId",
        "participants",
      ]) || !Array.isArray(value.participants) ||
      value.participants.length > MAX_PRESENCE_PARTICIPANTS
    ) {
      throw new Error("Presence snapshot message is invalid");
    }
    const selfParticipantId = decodeParticipantId(value.selfParticipantId);
    const participants = value.participants.map(decodeParticipant);
    const participantIds = new Set(
      participants.map((participant) => participant.participantId),
    );
    if (
      participantIds.size !== participants.length ||
      participantIds.has(selfParticipantId)
    ) {
      throw new Error("Presence snapshot participants are invalid");
    }
    return {
      type: "room.snapshot",
      snapshot: {
        selfParticipantId,
        participants,
      },
    };
  }
  throw new Error("Presence message type is invalid");
}

/** Builds the versioned room endpoint without exposing the room in failures. */
export function copresenceRoomUrl(serviceUrl: string, room: string): string {
  if (!roomPattern.test(room)) {
    throw new Error("Presence room is invalid");
  }
  const url = new URL(serviceUrl);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Presence service URL must use WebSocket transport");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Presence service URL must not contain credentials or query data",
    );
  }
  url.pathname = `/v1/rooms/${encodeURIComponent(room)}`;
  return url.toString();
}

function defaultScheduleFrame(callback: FrameRequestCallback): number {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  queueMicrotask(() => callback(performance.now()));
  return 0;
}

function defaultCancelFrame(handle: number): void {
  globalThis.cancelAnimationFrame?.(handle);
}

/** Relays latest-value editor presence over one independently lossy socket. */
export class CopresenceSession {
  #socket: PresenceSocket;
  #scheduleFrame: (callback: FrameRequestCallback) => number;
  #cancelFrame: (handle: number) => void;
  #onMessage: (message: PresenceServerMessage) => void;
  #onFailure: (category: PresenceFailureCategory) => void;
  #revision = 0;
  #pending: PresencePublication | undefined;
  #frame: number | undefined;
  #snapshotReceived = false;
  #participantIds = new Set<string>();
  #disposed = false;
  #failed = false;
  #socketClosed = false;

  /** Opens one session for the validated service URL and room. */
  constructor(options: CopresenceSessionOptions) {
    this.#scheduleFrame = options.scheduleFrame ?? defaultScheduleFrame;
    this.#cancelFrame = options.cancelFrame ?? defaultCancelFrame;
    this.#onMessage = options.onMessage;
    this.#onFailure = options.onFailure;
    const url = copresenceRoomUrl(options.serviceUrl, options.room);
    this.#socket = options.createSocket?.(url) ?? new WebSocket(url);
    this.#socket.addEventListener("open", () => this.#schedule());
    this.#socket.addEventListener("message", (event) => this.#receive(event));
    this.#socket.addEventListener("error", () => this.#fail("connection"));
    this.#socket.addEventListener("close", () => {
      this.#socketClosed = true;
      if (!this.#disposed && !this.#failed) this.#fail("connection", false);
    });
  }

  /** Coalesces the latest local state at the browser animation-frame boundary. */
  publish(publication: PresencePublication): void {
    if (this.#disposed || this.#failed) return;
    decodeName(publication.name);
    decodeCursor(publication.cursor);
    decodeSelection(publication.selection);
    if (
      (publication.focused && publication.selection === null) ||
      (publication.basis !== "provisional" &&
        publication.basis !== "confirmed")
    ) {
      throw new Error("Presence publication is invalid");
    }
    this.#pending = publication;
    this.#schedule();
  }

  /** Cancels pending publication and closes the room socket exactly once. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#frame !== undefined) this.#cancelFrame(this.#frame);
    this.#frame = undefined;
    this.#pending = undefined;
    this.#closeSocket(1000, "Presence session ended");
  }

  #schedule(): void {
    if (
      this.#frame !== undefined || this.#pending === undefined ||
      this.#socket.readyState !== openSocketState || this.#disposed ||
      this.#failed || !this.#snapshotReceived
    ) return;
    this.#frame = this.#scheduleFrame(() => {
      this.#frame = undefined;
      this.#send();
    });
  }

  #send(): void {
    const pending = this.#pending;
    if (
      pending === undefined || this.#socket.readyState !== openSocketState ||
      this.#disposed || this.#failed
    ) return;
    this.#pending = undefined;
    this.#revision++;
    const message = JSON.stringify({
      v: protocolVersion,
      type: "participant.upsert",
      revision: this.#revision,
      ...pending,
    });
    if (new TextEncoder().encode(message).length > maximumUpsertMessageBytes) {
      this.#fail("protocol");
      return;
    }
    try {
      this.#socket.send(message);
    } catch {
      this.#fail("connection");
    }
  }

  #receive(event: MessageEvent): void {
    if (this.#disposed || this.#failed) return;
    try {
      if (typeof event.data !== "string") {
        throw new Error("Presence messages must be text");
      }
      const messageBytes = new TextEncoder().encode(event.data).length;
      if (messageBytes > maximumServerMessageBytes) {
        throw new Error("Presence message is too large");
      }
      const message = decodePresenceServerMessage(JSON.parse(event.data));
      if (
        this.#snapshotReceived !== (message.type !== "room.snapshot")
      ) {
        throw new Error("Presence room snapshot is out of order");
      }
      if (
        message.type !== "room.snapshot" &&
        messageBytes > maximumUpsertMessageBytes
      ) {
        throw new Error("Presence message is too large");
      }
      if (message.type === "room.snapshot") {
        this.#participantIds = new Set(
          message.snapshot.participants.map((participant) =>
            participant.participantId
          ),
        );
        this.#snapshotReceived = true;
        this.#schedule();
      } else if (message.type === "participant.upsert") {
        if (
          !this.#participantIds.has(message.participant.participantId) &&
          this.#participantIds.size >= MAX_PRESENCE_PARTICIPANTS
        ) {
          throw new Error("Presence room participant limit was exceeded");
        }
        this.#participantIds.add(message.participant.participantId);
      } else {
        this.#participantIds.delete(message.participantId);
      }
      this.#onMessage(message);
    } catch {
      this.#fail("protocol");
    }
  }

  #fail(category: PresenceFailureCategory, closeSocket = true): void {
    if (this.#failed || this.#disposed) return;
    this.#failed = true;
    if (this.#frame !== undefined) this.#cancelFrame(this.#frame);
    this.#frame = undefined;
    this.#pending = undefined;
    if (closeSocket) this.#closeSocket(1002, "Presence session failed");
    this.#onFailure(category);
  }

  #closeSocket(code: number, reason: string): void {
    if (this.#socketClosed) return;
    this.#socketClosed = true;
    try {
      this.#socket.close(code, reason);
    } catch {
      // Closing a failed transport is best-effort and must not obscure the
      // single safe failure category delivered to the component.
    }
  }
}
