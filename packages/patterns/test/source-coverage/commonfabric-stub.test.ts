export type BuiltInLLMMessage = Record<string, unknown>;
export type BuiltInLLMTool = Record<string, unknown>;
export type Default<T> = T;
export type PatternToolResult<T = Record<string, never>> = {
  pattern: unknown;
  extraParams: T;
};
export type Reactive<T> = T;
export type Stream<T = unknown> = {
  send(event?: T): unknown;
  sendCount: number;
  lastEvent?: T;
};
export type VNode = unknown;
export type WishState<T> = { result?: T; candidates?: T[] };

export const NAME = "__name";
export const UI = "__ui";
export const TILE_UI = "__tile_ui";
export const SELF = "__self";

const wishResults = new Map<string, unknown>();
let generateTextResult: {
  pending: boolean;
  result?: unknown;
  error?: unknown;
} = {
  pending: false,
  result: "",
  error: undefined,
};

export function setWishResult(query: string, result: unknown): void {
  wishResults.set(query, result);
}

export function clearWishResults(): void {
  wishResults.clear();
}

export function setGenerateTextResult(result: {
  pending: boolean;
  result?: unknown;
  error?: unknown;
}): void {
  generateTextResult = result;
}

export function clearGenerateTextResult(): void {
  generateTextResult = {
    pending: false,
    result: "",
    error: undefined,
  };
}

export class Writable<T = unknown> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  get(): T {
    return this.#value;
  }

  set(value: T): void {
    this.#value = value;
  }

  push(
    ...values: T extends Array<infer U> ? U[] : unknown[]
  ): void {
    if (!Array.isArray(this.#value)) {
      throw new Error("push requires an array value");
    }
    (this.#value as unknown[]).push(...values);
  }

  addUnique(
    ...values: T extends Array<infer U> ? U[] : unknown[]
  ): void {
    if (!Array.isArray(this.#value)) {
      throw new Error("addUnique requires an array value");
    }
    const current = this.#value as unknown[];
    for (const value of values) {
      if (!current.some((item) => equals(item, value))) {
        current.push(value);
      }
    }
  }

  removeByValue(value: unknown): void {
    if (!Array.isArray(this.#value)) return;
    this.#value = (this.#value as unknown[]).filter((item) =>
      !equals(item, value)
    ) as T;
  }

  key(key: PropertyKey): Writable<unknown> {
    return new Proxy(new Writable(readKey(this.#value, key)), {
      get: (target, property, receiver) => {
        if (property === "get") {
          return () => readKey(this.#value, key);
        }
        if (property === "set") {
          return (value: unknown) => {
            if (this.#value == null) {
              this.#value = (typeof key === "number" ? [] : {}) as T;
            }
            writeKey(this.#value, key, value);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  for(_label: string): this {
    return this;
  }

  sync(): this {
    return this;
  }

  map<U>(callback: (value: unknown, index: number) => U): U[] {
    return Array.isArray(this.#value)
      ? (this.#value as unknown[]).map(callback)
      : [];
  }

  filter(callback: (value: unknown, index: number) => boolean): unknown[] {
    return Array.isArray(this.#value)
      ? (this.#value as unknown[]).filter(callback)
      : [];
  }

  slice(...args: [number?, number?]): unknown[] {
    return Array.isArray(this.#value)
      ? (this.#value as unknown[]).slice(...args)
      : [];
  }

  get length(): number {
    return Array.isArray(this.#value) ? this.#value.length : 0;
  }

  [Symbol.iterator](): IterableIterator<unknown> {
    return Array.isArray(this.#value)
      ? (this.#value as unknown[])[Symbol.iterator]()
      : [][Symbol.iterator]();
  }
}

function readKey(value: unknown, key: PropertyKey): unknown {
  if (value == null) return undefined;
  return (value as Record<PropertyKey, unknown>)[key];
}

function writeKey(value: unknown, key: PropertyKey, nextValue: unknown): void {
  (value as Record<PropertyKey, unknown>)[key] = nextValue;
}

export const Cell = {
  of<T>(value: T): Writable<T> {
    return new Writable(value);
  },
};

export function pattern<TInput, TOutput>(
  body: (input: TInput) => TOutput,
  ..._rest: unknown[]
): (input?: Partial<TInput>) => TOutput {
  return (input = {} as Partial<TInput>) => body(input as TInput);
}

export function handler<TEvent, TState>(
  ...args:
    | [body: (event: TEvent, state: TState) => unknown]
    | [
      _inputSchema: unknown,
      _stateSchema: unknown,
      body: (event: TEvent, state: TState) => unknown,
    ]
): (state: TState) => Stream<TEvent> {
  const body = args[args.length - 1] as (
    event: TEvent,
    state: TState,
  ) => unknown;
  return (state) => {
    const stream: Stream<TEvent> = {
      sendCount: 0,
      send(event?: TEvent) {
        stream.sendCount++;
        stream.lastEvent = event;
        if (body.constructor.name === "AsyncFunction") {
          return Promise.resolve(undefined);
        }
        return body(event as TEvent, state);
      },
    };
    return stream;
  };
}

export function action(body: () => unknown): Stream<void> {
  return {
    sendCount: 0,
    send() {
      this.sendCount++;
      return body();
    },
  };
}

export function computed<T>(body: () => T): T {
  return body();
}

export function lift<TInput, TOutput>(
  body: (input: TInput) => TOutput,
): (input: TInput) => TOutput {
  return (input) => body(input);
}

export function ifElse<T>(condition: unknown, truthy: T, falsy: T): T {
  return condition ? truthy : falsy;
}

export function when<T>(condition: unknown, value: T): T | undefined {
  return condition ? value : undefined;
}

export function unless<T>(condition: unknown, value: T): T | undefined {
  return condition ? undefined : value;
}

export function wish<T>({ query }: { query: string }): WishState<T> {
  return { result: wishResults.get(query) as T | undefined };
}

export function fetchJson<T>(
  _params: Record<string, unknown>,
): T {
  // A GitHub-repo-shaped stub: covers both `stargazers_count` readers and
  // patterns that walk further into the response (owner, name, etc.).
  return {
    name: "stub-repo",
    owner: { login: "stub-owner" },
    description: "stub description",
    stargazers_count: 123,
    forks_count: 0,
    language: "TypeScript",
    html_url: "https://example.com/stub-repo",
  } as T;
}

export function fetchJsonUnchecked(
  _params: Record<string, unknown>,
): unknown {
  return { stargazers_count: 123 };
}

export function fetchText(
  _params: Record<string, unknown>,
): string {
  return "stub text";
}

export function fetchBinary(
  _params: Record<string, unknown>,
): { bytes: Uint8Array; mediaType: string } {
  return { bytes: new Uint8Array(), mediaType: "application/octet-stream" };
}

type PendingResult = { pending: true };
type ErrorResult = { error: Error };
type UnavailableResult = PendingResult | ErrorResult;

function currentGenerateTextValue(): string | UnavailableResult {
  if (generateTextResult.pending) return { pending: true };
  if (generateTextResult.error) {
    return {
      error: generateTextResult.error instanceof Error
        ? generateTextResult.error
        : new Error(String(generateTextResult.error)),
    };
  }
  return typeof generateTextResult.result === "string"
    ? generateTextResult.result
    : "";
}

export function resultOf<T>(value: T): Exclude<T, UnavailableResult> {
  return value as Exclude<T, UnavailableResult>;
}

export function isPending(value: unknown): value is PendingResult {
  return typeof value === "object" && value !== null &&
    (value as { pending?: unknown }).pending === true;
}

export function hasError(value: unknown): value is ErrorResult {
  return typeof value === "object" && value !== null &&
    (value as { error?: unknown }).error instanceof Error;
}

export function generateObject<T>(
  _params: Record<string, unknown>,
): T | UnavailableResult {
  return {} as T;
}

export function generateText(
  _params: Record<string, unknown>,
): string | UnavailableResult {
  return currentGenerateTextValue();
}

export function generateObjectStream<T>(
  _params: Record<string, unknown>,
): T | UnavailableResult {
  return {} as T;
}

export function generateTextStream(
  _params: Record<string, unknown>,
): string | UnavailableResult {
  return currentGenerateTextValue();
}

export function partialResultOf(
  _value: unknown,
): string | UnavailableResult {
  return currentGenerateTextValue();
}

export function llmDialog<T>(
  _params: Record<string, unknown>,
): {
  pending: false;
  result?: T;
  addMessage: Stream<BuiltInLLMMessage>;
  error?: string;
} {
  return {
    pending: false,
    addMessage: handler<BuiltInLLMMessage, Record<string, never>>(() => {})({}),
  };
}

export function patternTool<T>(
  patternValue: unknown,
  extraParams?: T,
): PatternToolResult<T> {
  return { pattern: patternValue, extraParams: extraParams as T };
}

export function toSchema<T>(): T {
  return {} as T;
}

export function str(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += String(values[i]);
  }
  return out;
}

export function equals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function toIndentedDebugString(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function toCompactDebugString(value: unknown): string {
  return JSON.stringify(value);
}

export function nonPrivateRandom(): number {
  return 0.123456789;
}

export function safeDateNow(): number {
  return 1_700_000_000_000;
}

export function getPatternEnvironment(): { apiUrl: URL } {
  return { apiUrl: new URL("http://localhost/") };
}

export function navigateTo(value: unknown): unknown {
  return value;
}

export function compileAndRun<T = unknown>(): T | UnavailableResult {
  return {} as T;
}

export function fetchProgram(): { files: never[]; main: string } {
  return { files: [], main: "" };
}

export function streamData(): { pending: false; result: undefined } {
  return { pending: false, result: undefined };
}

export function byRef(_ref: string): () => Record<string, never> {
  return () => ({});
}

export function createNodeFactory(): unknown {
  return undefined;
}

export function __cf_data<T>(value: T): T {
  return value;
}

export function findEventHandlers(
  node: unknown,
  eventName: string,
): Array<() => unknown> {
  const handlers: Array<() => unknown> = [];
  const visit = (value: unknown) => {
    if (value == null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const props = (value as { props?: Record<string, unknown> }).props;
    const handlerValue = props?.[eventName];
    if (typeof handlerValue === "function") {
      handlers.push(handlerValue as () => unknown);
    } else if (
      handlerValue &&
      typeof handlerValue === "object" &&
      typeof (handlerValue as { send?: unknown }).send === "function"
    ) {
      handlers.push(() => (handlerValue as Stream<unknown>).send());
    }
    visit((value as { children?: unknown }).children);
    visit(props?.children);
  };
  visit(node);
  return handlers;
}

export function textContent(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (typeof node === "object") {
    const value = node as {
      children?: unknown;
      props?: { children?: unknown };
    };
    return textContent(value.children) + textContent(value.props?.children);
  }
  return "";
}
