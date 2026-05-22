import { nonPrivateRandom, safeDateNow } from "commonfabric";

export type MessageOrigin = "sent" | "imported";

export interface ChatProfile {
  readonly name: string;
  readonly accentColor: string;
}

export interface ParticipantClaim<ProfileRef = unknown> {
  readonly name: string;
  readonly accentColor: string;
  readonly profile?: ProfileRef;
}

export interface SentChatMessage<ProfileRef = unknown> {
  readonly origin: "sent";
  readonly id: string;
  readonly authorName: string;
  readonly authorProfile: ProfileRef;
  readonly body: string;
  readonly timestamp: number;
}

export interface ImportedClaimedChatMessage<ProfileRef = unknown> {
  readonly origin: "imported";
  readonly id: string;
  readonly authorName: string;
  readonly authorProfile?: ProfileRef;
  readonly body: string;
  readonly timestamp: number;
}

export type PlainChatMessage<ProfileRef = unknown> =
  | SentChatMessage<ProfileRef>
  | ImportedClaimedChatMessage<ProfileRef>;

export interface ChatRoom<Message = PlainChatMessage> {
  readonly id: string;
  readonly name: string;
  readonly messages: Message[];
  readonly createdAt: number;
}

const PROFILE_COLORS = [
  "#2563eb",
  "#059669",
  "#dc2626",
  "#7c3aed",
  "#c2410c",
  "#0f766e",
] as const;

const RANDOM_IMPORTED_BODIES = [
  "Jumping in late here.",
  "I think we already covered this above.",
  "Can we loop back on the last point?",
  "Sharing a quick update from the thread.",
  "I might be missing context, but this seems fine.",
] as const;

const hashText = (text: string): number =>
  Array.from(text).reduce(
    (hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0,
    0,
  );

export const accentColorForName = (name: string): string =>
  PROFILE_COLORS[hashText(name) % PROFILE_COLORS.length] ?? PROFILE_COLORS[0];

export const makeProfileSnapshot = (
  name: string,
  previous?: ChatProfile,
): ChatProfile => ({
  name,
  accentColor: previous?.accentColor ?? accentColorForName(name),
});

const createId = (prefix: string): string =>
  `${prefix}-${safeDateNow()}-${nonPrivateRandom().toString(36).slice(2, 8)}`;

export const createSentMessageSnapshot = <ProfileRef>(
  authorProfile: ProfileRef,
  author: ChatProfile,
  body: string,
): SentChatMessage<ProfileRef> => ({
  origin: "sent",
  id: createId("msg"),
  authorName: author.name,
  authorProfile,
  body,
  timestamp: safeDateNow(),
});

export const createRoomSnapshot = <Message>(
  name: string,
): ChatRoom<Message> => ({
  id: createId("room"),
  name,
  messages: [],
  createdAt: safeDateNow(),
});

const createImportedClaimedMessage = <ProfileRef>(
  author: ParticipantClaim<ProfileRef>,
  body: string,
  timestamp: number,
): ImportedClaimedChatMessage<ProfileRef> => ({
  origin: "imported",
  id: createId("imported"),
  authorName: author.name,
  ...(author.profile !== undefined ? { authorProfile: author.profile } : {}),
  body,
  timestamp,
});

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

export const createRandomImportedClaimedMessages = <ProfileRef>(
  existingMessages: readonly PlainChatMessage<ProfileRef>[],
  participants: readonly ParticipantClaim<ProfileRef>[],
): ImportedClaimedChatMessage<ProfileRef>[] => {
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
      return undefined;
    }
    const timestamp = randomInsertTimestamp(workingMessages);
    const message = createImportedClaimedMessage(author, body, timestamp);
    workingMessages.push(message);
    return message;
  }).filter((message): message is ImportedClaimedChatMessage<ProfileRef> =>
    message !== undefined
  );
};
