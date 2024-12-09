import {
  service,
  $,
  refer,
  Instruction,
  Session,
  Task,
  Fact,
  h,
} from "@commontools/common-system";
import { Reference } from "merkle-reference";

const provider = refer({
  effect: { fetch: { version: [0, 0, 1] } },
});

export const REQUEST = {
  STATUS: 'request/status',
  STATUS_CODE: 'request/status/code',
  STATUS_TEXT: 'request/status/text',
}
export const RESPONSE = {
  JSON: 'response/json',
  TEXT: 'response/text',
  BYTES: 'response/bytes',
}

type State =
  | { status: "Open"; source: Fetch }
  | { status: "Sending"; source: Fetch; response: Promise<Response> }
  | { status: "Receiving"; source: Fetch; content: Promise<{}> }
  | { status: "Complete"; source: Fetch; content: {} };

export default service({
  'fetch/send': {
    select: {
      request: $.request,
    },
    where: [{ Case: [provider, `~/send`, $.request] }],
    *perform({ request }: { request: Reference }): Task.Task<Instruction[]> {
      const effect = Session.resolve<State>(request);
      if (effect?.status === "Open") {
        const state = {
          status: "Sending",
          source: effect.source,
          response: globalThis.fetch(effect.source.request),
        }

        return [
          { Retract: [provider, "~/send", request] },
          { Upsert: [provider, "~/receive", state as any] },
          { Upsert: [effect.source.consumer, effect.source.port, effect.source.id] },
          { Upsert: [effect.source.id, REQUEST.STATUS, "Sending"] },
        ];
      }
      return [];
    },
  },
  'fetch/receive': {
    select: {
      request: $.request,
    },
    where: [{ Case: [provider, `~/receive`, $.request] }],
    *perform({ request }: { request: Reference }) {
      const effect = Session.resolve<State>(request);
      if (effect?.status === "Sending") {
        const response = yield* Task.wait(effect.response);
        const { expect } = effect.source;
        const content =
          expect === "text"
            ? response.text()
            : expect === "json"
              ? response.json()
              : response.arrayBuffer();

        const state = {
          status: "Receiving",
          source: effect.source,
          content,
        }

        return [
          { Retract: [provider, "~/receive", request] },
          { Upsert: [provider, `~/complete`, state as any] },
          { Upsert: [effect.source.id, REQUEST.STATUS, "Receiving"] },
          { Upsert: [effect.source.id, REQUEST.STATUS_CODE, response.status] },
          { Upsert: [effect.source.id, REQUEST.STATUS_TEXT, response.statusText] },
        ];
      }

      return [];
    },
  },
  'fetch/complete': {
    select: {
      request: $.request,
    },
    where: [{ Case: [provider, `~/complete`, $.request] }],
    *perform({ request }: { request: Reference }) {
      const changes: Instruction[] = [];
      const effect = Session.resolve<State>(request);
      if (effect?.status === "Receiving") {
        const content = yield* Task.wait(effect.content);
        console.log({ request, content, effect });
        changes.push(
          { Retract: [provider, `~/complete`, request] },
          { Assert: [provider, "effect/log", request] },
          { Upsert: [effect.source.id, REQUEST.STATUS, "Complete"] },
        );

        if (effect.source.expect === "json") {
          const id = refer(content); // NOTE(ja):
          changes.push(
            { Import: content },
            { Upsert: [effect.source.id, RESPONSE.JSON, id] },
          );
        } else if (effect.source.expect === "text") {
          let text: string;
          if (typeof content !== 'string') {
            text = JSON.stringify(content)
          } else {
            text = content;
          }

          changes.push({
            Upsert: [effect.source.id, RESPONSE.TEXT, text],
          });
        } else {
          changes.push({
            Upsert: [
              request,
              RESPONSE.BYTES,
              new Uint8Array(content as ArrayBuffer),
            ],
          });
        }
      }

      return changes;
    },
  },

  'fetch/idle': {
    select: {
      self: $.self,
    },
    where: [{ Not: { Case: [provider, `effect/log`, $._] } }],
    *perform({ self }: { self: Reference }) {
      return [
        {
          Upsert: [
            self,
            "~/common/ui",
            <div title="Fetch Effect UI" entity={self}>
              🚧 🏗️
            </div>,
          ],
        },
      ];
    },
  },

  'fetch/active': {
    select: {
      self: $.self,
      requests: [{ request: $.request, state: $.state }],
    },
    where: [
      { Case: [provider, "effect/log", $.request] },
      { Case: [$.request, `request/status`, $.state] },
      // { Match: ["unknown", "==", $.status] },
    ],
    *perform({
      self,
      requests,
    }: {
      self: Reference;
      requests: { request: Reference; state: string }[];
    }) {
      return [
        {
          Upsert: [
            self,
            "~/common/ui",
            <div title="Fetch Effect UI" entity={self}>
              <ul>
                {...requests.map(({ request, state }) => (
                  <li>
                    {state} {String(request)}
                  </li>
                ))}
              </ul>
            </div>,
          ],
        },
      ];
    },
  },

  // view: {
  //   select: {
  //     self: $.self,
  //     effects: [
  //       {
  //         request: $.request,
  //         // status: $.status,
  //       },
  //     ],
  //   },
  //   where: [
  //     {
  //       Or: [
  //         { Case: [provider, "~/send", $.request] },
  //         // { Case: [provider, "~/receive", $.request] },
  //         // { Case: [provider, "~/complete", $.request] },
  //       ],
  //     },
  //     // { Case: [$.request, REQUEST.STATUS, $.status] },
  //   ],
  //   *perform({
  //     self,
  //     effects,
  //   }: {
  //     self: Reference;
  //     effects: { request: Reference }[];
  //   }) {
  //     const view = (
  //       <div title="Fetch Effect UI" entity={self}>
  //         {effects.length}
  //       </div>
  //     );

  //     return [{ Upsert: [self, "~/common/ui", view] }];
  //   },
  // },
});

export const fetch = (consumer: Reference, port: string, request: Request) =>
  new Fetch(consumer, port, request, "bytes");

type LlmRequest = {
  prompt?: string;
  messages?: {
    role: string; content: string;
  }[];
  system?: string;
  model?: string,
  max_tokens?: number,
  stop?: string,
}

export const LLM_SERVER_URL =
  typeof window !== "undefined"
    ? window.location.protocol + "//" + window.location.host + "/api/llm"
    : "//api/llm";

export const llm = (consumer: Reference, port: string, request: LlmRequest) =>
  new Fetch(consumer, port, new Request(
    LLM_SERVER_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet",
        max_tokens: 4096,
        ...request,
        messages: request.messages || [{ role: "user", content: request.prompt }],
      }),
    }
  ), "json");

export type Expect = "text" | "json" | "bytes";

export class Fetch {
  consumer: Reference;
  port: string;
  request: Request;
  expect: Expect;
  id: Reference;
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
    this.id = refer({
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
  }

  get Assert(): Fact {
    return [provider, `~/send`, { status: "Open", source: this } as any];
  }

  text() {
    return new Fetch(this.consumer, this.port, this.request, "text");
  }
  json() {
    return new Fetch(this.consumer, this.port, this.request, "json");
  }
}
