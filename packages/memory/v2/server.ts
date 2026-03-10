import type { Provider, Protocol } from "../provider.ts";
import {
  MEMORY_V2_PROTOCOL,
  type ClientMessage,
  type ServerMessage,
  type SessionId,
  type SessionOpenArgs,
  type SessionOpenCommand,
  type SessionOpenResult,
  type V2Error,
} from "../v2.ts";

type SessionState = {
  id: SessionId;
  seenSeq: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class SessionRegistry {
  #sessions = new Map<SessionId, SessionState>();

  open(args: SessionOpenArgs = {}, serverSeq = 0): SessionOpenResult {
    const sessionId = args.sessionId ?? crypto.randomUUID();
    const existing = this.#sessions.get(sessionId);
    const seenSeq = args.seenSeq ?? existing?.seenSeq ?? 0;
    this.#sessions.set(sessionId, { id: sessionId, seenSeq });
    return { sessionId, serverSeq };
  }
}

export const parseClientMessage = (payload: string): ClientMessage | null => {
  try {
    const parsed = JSON.parse(payload);
    if (!isRecord(parsed) || parsed.cmd !== "session.open") {
      return null;
    }

    if (
      typeof parsed.id !== "string" ||
      !isRecord(parsed.args) ||
      typeof parsed.protocol !== "string"
    ) {
      return null;
    }

    return {
      cmd: "session.open",
      id: parsed.id as SessionOpenCommand["id"],
      protocol: parsed.protocol as SessionOpenCommand["protocol"],
      args: {
        sessionId: typeof parsed.args.sessionId === "string"
          ? parsed.args.sessionId
          : undefined,
        seenSeq: typeof parsed.args.seenSeq === "number"
          ? parsed.args.seenSeq
          : undefined,
      },
    };
  } catch {
    return null;
  }
};

const unsupported = (message: string): V2Error => ({
  name: "NotImplementedError",
  message,
});

export class Server {
  #sessions: SessionRegistry;
  #serverSeq: () => number;

  constructor(
    readonly options: {
      memory?: Provider<Protocol>;
      sessions?: SessionRegistry;
      serverSeq?: () => number;
    } = {},
  ) {
    this.#sessions = options.sessions ?? new SessionRegistry();
    this.#serverSeq = options.serverSeq ?? (() => 0);
  }

  async handle(message: ClientMessage): Promise<ServerMessage> {
    switch (message.cmd) {
      case "session.open":
        return this.open(message);
    }
  }

  async respond(payload: string): Promise<string | null> {
    const message = parseClientMessage(payload);
    if (message === null) {
      return null;
    }

    return JSON.stringify(await this.handle(message));
  }

  private async open(message: SessionOpenCommand): Promise<ServerMessage> {
    if (message.protocol !== MEMORY_V2_PROTOCOL) {
      return {
        the: "task/return",
        of: message.id,
        is: {
          error: unsupported(
            `Unsupported memory websocket protocol: ${message.protocol}`,
          ),
        },
      };
    }

    return {
      the: "task/return",
      of: message.id,
      is: {
        ok: this.#sessions.open(message.args, this.#serverSeq()),
      },
    };
  }
}
