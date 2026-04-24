import { nonPrivateRandom, safeDateNow } from "commonfabric";

export const SLOT_IDS = [
  "participant-1",
  "participant-2",
  "participant-3",
] as const;

export type SlotId = typeof SLOT_IDS[number];

export type MessageOrigin = "sent" | "imported";

type SlotMeta = {
  readonly id: SlotId;
  readonly label: string;
  readonly accentColor: string;
};

const SLOT_META: readonly SlotMeta[] = [
  {
    id: "participant-1",
    label: "Participant 1",
    accentColor: "#2563eb",
  },
  {
    id: "participant-2",
    label: "Participant 2",
    accentColor: "#059669",
  },
  {
    id: "participant-3",
    label: "Participant 3",
    accentColor: "#dc2626",
  },
] as const;

export type ParticipantProfile<Slot extends SlotId> = {
  readonly id: Slot;
  readonly slotLabel: string;
  readonly name: string;
  readonly accentColor: string;
};

export type ParticipantOne = ParticipantProfile<"participant-1">;
export type ParticipantTwo = ParticipantProfile<"participant-2">;
export type ParticipantThree = ParticipantProfile<"participant-3">;
export type Participant = ParticipantOne | ParticipantTwo | ParticipantThree;

export type ChatMessage<Slot extends SlotId, Origin extends MessageOrigin> = {
  readonly origin: Origin;
  readonly id: string;
  readonly author: ParticipantProfile<Slot>;
  readonly body: string;
  readonly timestamp: number;
};

export type SentChatMessageOne = ChatMessage<"participant-1", "sent">;
export type SentChatMessageTwo = ChatMessage<"participant-2", "sent">;
export type SentChatMessageThree = ChatMessage<"participant-3", "sent">;
export type PlainSentChatMessage =
  | SentChatMessageOne
  | SentChatMessageTwo
  | SentChatMessageThree;

export type ImportedClaimedChatMessage =
  | ChatMessage<"participant-1", "imported">
  | ChatMessage<"participant-2", "imported">
  | ChatMessage<"participant-3", "imported">;

export type PlainChatMessage =
  | PlainSentChatMessage
  | ImportedClaimedChatMessage;

const RANDOM_IMPORTED_BODIES = [
  "Jumping in late here.",
  "I think we already covered this above.",
  "Can we loop back on the last point?",
  "Sharing a quick update from the thread.",
  "I might be missing context, but this seems fine.",
] as const;

export const metaForSlot = (slotId: SlotId): SlotMeta =>
  SLOT_META.find((slot) => slot.id === slotId) ?? SLOT_META[0];

export const makeParticipantSnapshot = (
  slotId: SlotId,
  name: string,
): Participant => {
  const meta = metaForSlot(slotId);
  switch (slotId) {
    case "participant-1":
      return {
        id: "participant-1",
        slotLabel: meta.label,
        name,
        accentColor: meta.accentColor,
      };
    case "participant-2":
      return {
        id: "participant-2",
        slotLabel: meta.label,
        name,
        accentColor: meta.accentColor,
      };
    case "participant-3":
      return {
        id: "participant-3",
        slotLabel: meta.label,
        name,
        accentColor: meta.accentColor,
      };
  }
};

export const findParticipantBySlot = <ParticipantValue extends Participant>(
  participants: readonly ParticipantValue[],
  slotId: SlotId,
): ParticipantValue | undefined =>
  participants.find((participant) => participant.id === slotId);

export const sortParticipants = <ParticipantValue extends Participant>(
  participants: readonly ParticipantValue[],
): ParticipantValue[] =>
  SLOT_IDS.flatMap((slotId) => {
    const match = participants.find((participant) => participant.id === slotId);
    return match ? [match] : [];
  });

const createId = (prefix: string, slotId: SlotId): string =>
  `${prefix}-${slotId}-${safeDateNow()}-${
    nonPrivateRandom().toString(36).slice(2, 8)
  }`;

export const createSentMessageSnapshot = (
  slotId: SlotId,
  author: Participant,
  body: string,
): PlainSentChatMessage => {
  const timestamp = safeDateNow();
  const id = createId("msg", slotId);
  switch (slotId) {
    case "participant-1":
      return {
        origin: "sent",
        id,
        author: {
          id: "participant-1",
          slotLabel: author.slotLabel,
          name: author.name,
          accentColor: author.accentColor,
        },
        body,
        timestamp,
      };
    case "participant-2":
      return {
        origin: "sent",
        id,
        author: {
          id: "participant-2",
          slotLabel: author.slotLabel,
          name: author.name,
          accentColor: author.accentColor,
        },
        body,
        timestamp,
      };
    case "participant-3":
      return {
        origin: "sent",
        id,
        author: {
          id: "participant-3",
          slotLabel: author.slotLabel,
          name: author.name,
          accentColor: author.accentColor,
        },
        body,
        timestamp,
      };
  }
};

export const prepareSentMessageSnapshot = (
  participants: readonly Participant[],
  slotId: SlotId,
  rawBody: string,
): {
  trimmedBody: string | null;
  message: PlainSentChatMessage | null;
} => {
  const participantList = Array.from(participants);
  const trimmedBody = rawBody.trim();
  const sender = findParticipantBySlot(participantList, slotId);

  if (!trimmedBody || !sender) {
    return {
      trimmedBody: null,
      message: null,
    };
  }

  return {
    trimmedBody,
    message: createSentMessageSnapshot(slotId, sender, trimmedBody),
  };
};

const createImportedClaimedMessage = (
  author: Participant,
  body: string,
  timestamp: number,
): ImportedClaimedChatMessage => {
  const id = createId("imported", author.id);
  switch (author.id) {
    case "participant-1":
      return {
        origin: "imported",
        id,
        author: {
          id: "participant-1",
          slotLabel: author.slotLabel,
          name: author.name,
          accentColor: author.accentColor,
        },
        body,
        timestamp,
      };
    case "participant-2":
      return {
        origin: "imported",
        id,
        author: {
          id: "participant-2",
          slotLabel: author.slotLabel,
          name: author.name,
          accentColor: author.accentColor,
        },
        body,
        timestamp,
      };
    case "participant-3":
      return {
        origin: "imported",
        id,
        author: {
          id: "participant-3",
          slotLabel: author.slotLabel,
          name: author.name,
          accentColor: author.accentColor,
        },
        body,
        timestamp,
      };
  }
};

const compareMessagesByThreadOrder = (
  left: Pick<PlainChatMessage, "id" | "timestamp">,
  right: Pick<PlainChatMessage, "id" | "timestamp">,
): number =>
  left.timestamp === right.timestamp
    ? left.id.localeCompare(right.id)
    : left.timestamp - right.timestamp;

export const sortDisplayMessages = <
  Message extends Pick<PlainChatMessage, "id" | "timestamp">,
>(
  messages: readonly Message[],
): Message[] => Array.from(messages).sort(compareMessagesByThreadOrder);

const chooseRandom = <Value>(values: readonly Value[]): Value | undefined => {
  if (values.length === 0) {
    return undefined;
  }

  const index = Math.floor(nonPrivateRandom() * values.length);
  return values[index] ?? values[0];
};

const randomInsertTimestamp = (
  messages: readonly PlainChatMessage[],
): number => {
  const ordered = sortDisplayMessages(messages);
  if (ordered.length === 0) {
    return safeDateNow();
  }

  const slot = nonPrivateRandom() * (ordered.length + 1);
  const rightIndex = Math.floor(slot);
  const fractional = slot - rightIndex;
  if (rightIndex <= 0) {
    return ordered[0]!.timestamp - 1 - fractional;
  }
  if (rightIndex >= ordered.length) {
    return ordered[ordered.length - 1]!.timestamp + 1 + fractional;
  }

  const leftTimestamp = ordered[rightIndex - 1]!.timestamp;
  const rightTimestamp = ordered[rightIndex]!.timestamp;
  const gap = rightTimestamp - leftTimestamp;
  return gap > 0.001
    ? leftTimestamp + gap * (fractional === 0 ? 0.5 : fractional)
    : leftTimestamp + nonPrivateRandom() * 0.001;
};

export const createRandomImportedClaimedMessages = (
  existingMessages: readonly PlainChatMessage[],
  participants: readonly Participant[],
): ImportedClaimedChatMessage[] => {
  const authorPool = Array.from(participants);
  const workingMessages = sortDisplayMessages(existingMessages);
  const insertCount = Math.min(3, workingMessages.length);
  if (authorPool.length === 0 || insertCount === 0) {
    return [];
  }

  return Array.from({ length: insertCount }, () => {
    const author = chooseRandom(authorPool);
    const body = chooseRandom(RANDOM_IMPORTED_BODIES);
    if (!author || !body) {
      return null;
    }

    const message = createImportedClaimedMessage(
      author,
      body,
      randomInsertTimestamp(workingMessages),
    );
    workingMessages.push(message);
    workingMessages.sort(compareMessagesByThreadOrder);
    return message;
  }).flatMap((message) => message ? [message] : []);
};
