import { type Cfc, nonPrivateRandom, safeDateNow } from "commonfabric";

export const SLOT_IDS = [
  "participant-1",
  "participant-2",
  "participant-3",
] as const;

export type SlotId = typeof SLOT_IDS[number];

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

export type AuthorshipIntegrity<Author extends string> = {
  readonly kind: "authored-by";
  readonly subject: Author;
};

type ParticipantProfile<Slot extends SlotId> = {
  readonly id: Slot;
  readonly slotLabel: string;
  readonly name: string;
  readonly accentColor: string;
};

type ChatMessage<Slot extends SlotId> = {
  readonly id: string;
  readonly author: ParticipantProfile<Slot>;
  readonly body: string;
  readonly timestamp: number;
};

const RANDOM_INVALID_BODIES = [
  "Jumping in late here.",
  "I think we already covered this above.",
  "Can we loop back on the last point?",
  "Sharing a quick update from the thread.",
  "I might be missing context, but this seems fine.",
] as const;

type TrustedParticipantOne = Cfc<
  ParticipantProfile<"participant-1">,
  { integrity: readonly [AuthorshipIntegrity<"participant-1">] }
>;

type TrustedParticipantTwo = Cfc<
  ParticipantProfile<"participant-2">,
  { integrity: readonly [AuthorshipIntegrity<"participant-2">] }
>;

type TrustedParticipantThree = Cfc<
  ParticipantProfile<"participant-3">,
  { integrity: readonly [AuthorshipIntegrity<"participant-3">] }
>;

export type TrustedParticipant =
  | TrustedParticipantOne
  | TrustedParticipantTwo
  | TrustedParticipantThree;

export type TrustedMessageOne = Cfc<
  ChatMessage<"participant-1">,
  { integrity: readonly [AuthorshipIntegrity<"participant-1">] }
>;

export type TrustedMessageTwo = Cfc<
  ChatMessage<"participant-2">,
  { integrity: readonly [AuthorshipIntegrity<"participant-2">] }
>;

export type TrustedMessageThree = Cfc<
  ChatMessage<"participant-3">,
  { integrity: readonly [AuthorshipIntegrity<"participant-3">] }
>;

export type TrustedChatMessage =
  | TrustedMessageOne
  | TrustedMessageTwo
  | TrustedMessageThree;

export type ClaimedParticipant = ParticipantProfile<SlotId>;

export type InvalidClaimedChatMessage =
  | ChatMessage<"participant-1">
  | ChatMessage<"participant-2">
  | ChatMessage<"participant-3">;

export type DisplayChatMessage = TrustedChatMessage | InvalidClaimedChatMessage;

export const metaForSlot = (slotId: SlotId): SlotMeta =>
  SLOT_META.find((slot) => slot.id === slotId) ?? SLOT_META[0];

export const findParticipantBySlot = (
  participants: readonly TrustedParticipant[],
  slotId: SlotId,
): TrustedParticipant | undefined =>
  participants.find((participant) => participant.id === slotId);

const sortParticipants = (
  participants: readonly TrustedParticipant[],
): TrustedParticipant[] =>
  SLOT_IDS.flatMap((slotId) => {
    const match = participants.find((participant) => participant.id === slotId);
    return match ? [match] : [];
  });

const makeTrustedParticipant = (
  slotId: SlotId,
  name: string,
): TrustedParticipant => {
  const meta = metaForSlot(slotId);
  switch (slotId) {
    case "participant-1":
      return {
        id: "participant-1",
        slotLabel: meta.label,
        name,
        accentColor: meta.accentColor,
      } as TrustedParticipantOne;
    case "participant-2":
      return {
        id: "participant-2",
        slotLabel: meta.label,
        name,
        accentColor: meta.accentColor,
      } as TrustedParticipantTwo;
    case "participant-3":
      return {
        id: "participant-3",
        slotLabel: meta.label,
        name,
        accentColor: meta.accentColor,
      } as TrustedParticipantThree;
  }
};

const makeTrustedMessage = (
  slotId: SlotId,
  author: TrustedParticipant,
  body: string,
): TrustedChatMessage => {
  const timestamp = safeDateNow();
  const id = `msg-${slotId}-${timestamp}-${
    nonPrivateRandom().toString(36).slice(2, 8)
  }`;
  switch (slotId) {
    case "participant-1":
      return {
        id,
        author: {
          id: "participant-1",
          slotLabel: author.slotLabel,
          name: author.name,
          accentColor: author.accentColor,
        },
        body,
        timestamp,
      } as TrustedMessageOne;
    case "participant-2":
      return {
        id,
        author: {
          id: "participant-2",
          slotLabel: author.slotLabel,
          name: author.name,
          accentColor: author.accentColor,
        },
        body,
        timestamp,
      } as TrustedMessageTwo;
    case "participant-3":
      return {
        id,
        author: {
          id: "participant-3",
          slotLabel: author.slotLabel,
          name: author.name,
          accentColor: author.accentColor,
        },
        body,
        timestamp,
      } as TrustedMessageThree;
  }
};

const makeInvalidClaimedMessage = (
  author: TrustedParticipant,
  body: string,
  timestamp: number,
): InvalidClaimedChatMessage => {
  const id = `invalid-${author.id}-${safeDateNow()}-${
    nonPrivateRandom().toString(36).slice(2, 8)
  }`;
  switch (author.id) {
    case "participant-1":
      return {
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
  left: Pick<DisplayChatMessage, "id" | "timestamp">,
  right: Pick<DisplayChatMessage, "id" | "timestamp">,
): number =>
  left.timestamp === right.timestamp
    ? left.id.localeCompare(right.id)
    : left.timestamp - right.timestamp;

export const sortDisplayMessages = <Message extends DisplayChatMessage>(
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
  messages: readonly DisplayChatMessage[],
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

export const prepareTrustedMessageSend = (
  participants: readonly TrustedParticipant[],
  slotId: SlotId,
  rawBody: string,
): {
  trimmedBody: string | null;
  message: TrustedChatMessage | null;
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
    message: makeTrustedMessage(slotId, sender, trimmedBody),
  };
};

export const applyTrustedProfileSave = (
  participants: readonly TrustedParticipant[],
  slotId: SlotId,
  rawName: string,
): {
  trimmedName: string | null;
  nextParticipants: TrustedParticipant[];
} => {
  const participantList = Array.from(participants);
  const trimmedName = rawName.trim();
  if (!trimmedName) {
    return {
      trimmedName: null,
      nextParticipants: participantList,
    };
  }

  return {
    trimmedName,
    nextParticipants: sortParticipants([
      ...participantList.filter((participant) => participant.id !== slotId),
      makeTrustedParticipant(slotId, trimmedName),
    ]),
  };
};

export const applyTrustedMessageSend = (
  messages: readonly TrustedChatMessage[],
  participants: readonly TrustedParticipant[],
  slotId: SlotId,
  rawBody: string,
): {
  trimmedBody: string | null;
  nextMessages: TrustedChatMessage[];
} => {
  const messageList = Array.from(messages);
  const { trimmedBody, message } = prepareTrustedMessageSend(
    participants,
    slotId,
    rawBody,
  );
  if (!trimmedBody || !message) {
    return {
      trimmedBody: null,
      nextMessages: messageList,
    };
  }

  return {
    trimmedBody,
    nextMessages: [
      ...messageList,
      message,
    ],
  };
};

export const createRandomInvalidClaimedMessages = (
  existingMessages: readonly DisplayChatMessage[],
  participants: readonly TrustedParticipant[],
): InvalidClaimedChatMessage[] => {
  const authorPool = Array.from(participants);
  const workingMessages = sortDisplayMessages(existingMessages);
  const insertCount = Math.min(3, workingMessages.length);
  if (authorPool.length === 0 || insertCount === 0) {
    return [];
  }

  return Array.from({ length: insertCount }, () => {
    const author = chooseRandom(authorPool);
    const body = chooseRandom(RANDOM_INVALID_BODIES);
    if (!author || !body) {
      return null;
    }

    const message = makeInvalidClaimedMessage(
      author,
      body,
      randomInsertTimestamp(workingMessages),
    );
    workingMessages.push(message);
    workingMessages.sort(compareMessagesByThreadOrder);
    return message;
  }).flatMap((message) => message ? [message] : []);
};
