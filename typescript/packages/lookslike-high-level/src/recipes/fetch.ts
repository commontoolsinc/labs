import {
  service,
  $,
  refer,
  Reference,
  Instruction,
  Task,
  Fact,
} from "@commontools/common-system";
export type { Reference };

const provider = refer({
  effect: { fetch: { version: [0, 0, 1] } },
});

type State =
  | { status: "Open"; source: Fetch }
  | { status: "Sending"; source: Fetch; response: Promise<Response> }
  | { status: "Receiving"; source: Fetch; content: Promise<{}> }
  | { status: "Complete"; source: Fetch; content: {} };

const effects = new WeakMap<Reference, State>();

export default service({
  send: {
    select: {
      request: $.request,
    },
    where: [{ Case: [provider, "~/send", $.request] }],
    *perform({ request }: { request: Reference }): Task.Task<Instruction[]> {
      const effect = effects.get(request);
      if (effect?.status === "Open") {
        effects.set(request, {
          status: "Sending",
          source: effect.source,
          response: globalThis.fetch(effect.source.request),
        });

        return [
          { Retract: [provider, "~/send", request] },
          { Upsert: [provider, "~/receive", request] },
          { Upsert: [effect.source.consumer, "request/status", "Sending"] },
        ];
      }
      return [];
    },
  },
  receive: {
    select: {
      request: $.request,
    },
    where: [{ Case: [provider, `~/receive`, $.request] }],
    *perform({ request }: { request: Reference }) {
      const effect = effects.get(request);
      if (effect?.status === "Sending") {
        const response = yield* Task.wait(effect.response);
        const { expect } = effect.source;
        const content =
          expect === "text"
            ? response.text()
            : expect === "json"
              ? response.json()
              : response.arrayBuffer();

        effects.set(request, {
          status: "Receiving",
          source: effect.source,
          content,
        });

        return [
          { Retract: [provider, "~/receive", request] },
          { Upsert: [provider, `~/complete`, request] },
          { Upsert: [request, "request/status", "Receiving"] },
          { Upsert: [request, "response/status/code", response.status] },
          { Upsert: [request, "response/status/text", response.statusText] },
        ];
      }

      return [];
    },
  },
  complete: {
    select: {
      request: $.request,
    },
    where: [{ Case: [provider, `~/complete`, $.request] }],
    *perform({ request }: { request: Reference }) {
      const changes: Instruction[] = [];
      const effect = effects.get(request);
      if (effect?.status === "Receiving") {
        const content = yield* Task.wait(effect.content);
        effects.delete(request);
        changes.push(
          { Retract: [provider, `~/complete`, request] },
          { Upsert: [request, "request/status", "Complete"] },
        );

        if (effect.source.expect === "json") {
          const id = refer(content);
          changes.push(
            { Import: content },
            { Upsert: [request, `response/json`, id] },
          );
        } else if (effect.source.expect === "text") {
          changes.push({
            Upsert: [request, `response/text`, content as string],
          });
        } else {
          changes.push({
            Upsert: [
              request,
              `response/${effect.source.expect}`,
              new Uint8Array(content as ArrayBuffer),
            ],
          });
        }
      }

      return changes;
    },
  },
});

export const fetch = (consumer: Reference, port: string, request: Request) =>
  new Fetch(consumer, port, request, "bytes");

export type Expect = "text" | "json" | "bytes";

export class Fetch {
  consumer: Reference;
  port: string;
  request: Request;
  expect: Expect;
  constructor(
    consumer: Reference,
    port: string,
    request: Request,
    expect: Expect,
  ) {
    this.consumer = consumer;
    this.port = port;
    this.request = request;
    this.expect = expect;
  }

  get Assert(): Fact {
    const request = refer({
      provider,
      consumer: this.consumer,
      port: this.port,

      request: {
        url: this.request.url,
        method: this.request.method,
        headers: [
          ...(this.request.headers as unknown as Iterable<[string, string]>),
        ],
        expect: this.expect,
      },
    });

    effects.set(request, { status: "Open", source: this });

    return [provider, `~/fetch`, request];
  }

  get text() {
    return new Fetch(this.consumer, this.port, this.request, "text");
  }
  get json() {
    return new Fetch(this.consumer, this.port, this.request, "json");
  }
}
