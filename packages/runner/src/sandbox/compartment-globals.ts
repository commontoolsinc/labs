import { freezeSandboxRecordValues, freezeSandboxValue } from "./hardening.ts";
import {
  sandboxDateNow,
  sandboxFetchGate,
  sandboxRandom,
} from "../builder/safe-builtins.ts";

// A `Date` for the pattern sandbox whose ambient reads (`Date.now()` and the
// no-argument `new Date()`) route through the capability gate (coarse in a
// handler, throw in a lift/pattern-body), while every deterministic form
// (`new Date(value)`, `new Date(y, m, …)`, `Date.parse`, `Date.UTC`) and all
// prototype methods pass straight through to the real Date. This replaces the
// SES-tamed Date so authored `new Date()` is the safe API (W6). See
// docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md.
function createGatedDate(): DateConstructor {
  const RealDate = Date;
  // The deep prototype-chain reads (`Date.prototype.constructor.now()` and
  // deeper) reach the shared Date only when SES lockdown has already tamed it to
  // throw. If this ran before lockdown, that path would re-expose the real
  // clock, so fail loud rather than injecting a leaky Date.
  if (RealDate.prototype.constructor === RealDate) {
    throw new Error(
      "createGatedDate() requires SES lockdown to have run first " +
        "(Date.prototype.constructor must be tamed); call ensureSESLockdown()",
    );
  }
  // deno-lint-ignore no-explicit-any
  const GatedDate: any = function (this: unknown, ...args: unknown[]) {
    if (new.target) {
      const ctorArgs = args.length === 0 ? [sandboxDateNow()] : args;
      return Reflect.construct(RealDate, ctorArgs as [], new.target);
    }
    // `Date()` called as a plain function returns a string of "now".
    return new RealDate(sandboxDateNow()).toString();
  };
  GatedDate.now = () => sandboxDateNow();
  GatedDate.parse = RealDate.parse;
  GatedDate.UTC = RealDate.UTC;
  // GatedDate gets its own prototype that inherits the real Date methods but
  // whose `constructor` is GatedDate, so `(new Date()).constructor` is the gated
  // Date (not an ungated one) while `instanceof Date` and the methods still work.
  const gatedProto = Object.create(RealDate.prototype);
  Object.defineProperty(gatedProto, "constructor", {
    value: GatedDate,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  GatedDate.prototype = gatedProto;
  Object.defineProperty(GatedDate, "name", { value: "Date", writable: false });
  Object.defineProperty(GatedDate, "length", { value: 7 });
  return GatedDate as DateConstructor;
}

// A `Math` for the sandbox that keeps every real method/constant but routes
// `Math.random()` through the capability gate (raw entropy is allowed only in a
// handler; it breaks idempotency in a lift).
function createGatedMath(): typeof Math {
  const RealMath = Math as unknown as Record<PropertyKey, unknown>;
  const gated: Record<PropertyKey, unknown> = {};
  // Copy string and symbol keys (so `Symbol.toStringTag` -> "Math" survives).
  for (const key of Reflect.ownKeys(RealMath)) {
    gated[key] = RealMath[key];
  }
  gated.random = () => sandboxRandom();
  return gated as unknown as typeof Math;
}

// The settlement grid for the sandbox `fetch` (channel 7): the returned promise
// settles only on the wall-clock one-second grid, so the instant a pattern can
// observe carries no sub-second phase — the same resolution as the coarse
// handler clock (W1) and the #now grid.
const FETCH_SETTLE_GRID_MS = 1000;

// Statuses whose Response constructor forbids a body.
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

// A `fetch` for the pattern sandbox that closes the network round-trip clock
// (channel 7, see docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md):
//
//   - Handler-only (sandboxFetchGate): starting a request from a lift/computed
//     or the pattern body throws, mirroring the clock/entropy gate. Request
//     *initiation* instants therefore come from handler runs, whose delivery is
//     already shaped (W3/plan B).
//   - The whole response body is buffered before the promise settles, and the
//     settlement (fulfillment or rejection) is delayed to a wall-clock grid
//     boundary chosen from the request's ISSUE instant, not its arrival instant.
//     The pattern receives a Response built from the buffer, so every subsequent
//     read (`json()`, `text()`, `blob()`, `clone()`, body stream) completes in
//     microtasks — no later settlement carries real time.
//   - `content-encoding`/`content-length` are dropped from the rebuilt response:
//     they describe the wire form, not the buffered body.
//
// Why the boundary is chosen from the ISSUE instant, not arrival. Snapping to
// the next grid boundary AFTER arrival still leaks about one bit of sub-second
// phase per fetch: which boundary the arrival lands on depends on whether
// (issuePhase + roundTrip) crossed a grid line, and the handler continuation can
// read that boundary off the coarse clock (Date.now() is coarse-but-readable in
// a handler) and binary-search the issue phase by varying a known round trip.
// Instead, the settlement is issueBoundary + grid*(1 + ceil(roundTrip/grid)):
// a function of the coarse issue second and the round trip ROUNDED UP to the
// grid, and independent of the sub-second issue phase. It still reveals the
// coarse round-trip band (the same 1s-quantized latency the coarse clock already
// exposes for any interval), and adds up to two grid steps of settlement latency.
//
// What this deliberately does not hide: response *content* (a server can echo
// its own timestamps — that measures request arrival at the server, which is a
// shaped handler-run instant plus network noise, not a local fine clock), and
// settlement *order* of concurrent requests (ordering, not time).
export function createGatedFetch(
  hostFetch: typeof fetch,
  options: {
    gridMs?: number;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  } = {},
): typeof fetch {
  const gridMs = options.gridMs ?? FETCH_SETTLE_GRID_MS;
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Delay until the grid boundary derived from the issue instant (captured
  // before any await), so the settlement instant carries no sub-second phase of
  // when the request was issued. `now()` here reads the arrival instant; the
  // target is one grid step beyond the grid-rounded round trip, measured from the
  // issue boundary, so it is always strictly after arrival and phase-independent.
  const settleFromIssue = async (issueMs: number): Promise<void> => {
    const issueBoundary = Math.floor(issueMs / gridMs) * gridMs;
    const arrivalMs = now();
    const latency = Math.max(0, arrivalMs - issueMs);
    const target = issueBoundary + gridMs * (1 + Math.ceil(latency / gridMs));
    await wait(Math.max(0, target - arrivalMs));
  };

  const gatedFetch = async function fetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    sandboxFetchGate();
    const issueMs = now();
    let res: Response;
    let body: ArrayBuffer | null;
    try {
      res = await hostFetch(input, init);
      body = NULL_BODY_STATUSES.has(res.status)
        ? null
        : await res.arrayBuffer();
    } catch (error) {
      await settleFromIssue(issueMs);
      throw error;
    }
    await settleFromIssue(issueMs);
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    const buffered = new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
    // The constructor cannot set these; carry them as own properties so client
    // code reading `res.url` / `res.redirected` keeps working.
    Object.defineProperty(buffered, "url", { value: res.url });
    Object.defineProperty(buffered, "redirected", { value: res.redirected });
    return buffered;
  };
  return gatedFetch as typeof fetch;
}

const CONSOLE_METHOD_NAMES = [
  "assert",
  "clear",
  "count",
  "countReset",
  "debug",
  "dir",
  "dirxml",
  "error",
  "group",
  "groupCollapsed",
  "groupEnd",
  "info",
  "log",
  "table",
  "time",
  "timeEnd",
  "timeLog",
  "timeStamp",
  "trace",
  "warn",
] as const;
const EMPTY_CONSOLE_METHOD = freezeSandboxValue(() => undefined);

function createCompatibilityGlobals(): Record<string, unknown> {
  const globals: Record<string, unknown> = {};
  const hostGlobals = globalThis as typeof globalThis & Record<string, unknown>;

  if (typeof globalThis.fetch === "function") {
    // Gated fetch (channel 7): handler-only, with settlement coarsened to the
    // one-second grid, so a pattern's imperative network access carries no
    // fine clock. See createGatedFetch above.
    globals.fetch = freezeSandboxValue(
      createGatedFetch(globalThis.fetch.bind(globalThis)),
    );
  }

  globals.Proxy = undefined;

  // Gated ambient clock/entropy (W6): authored `new Date()` / `Date.now()` /
  // `Math.random()` become the safe API instead of the SES-tamed throw.
  globals.Date = freezeSandboxValue(createGatedDate());
  globals.Math = freezeSandboxValue(createGatedMath());

  for (
    const name of [
      "Headers",
      "Request",
      "Response",
      "structuredClone",
      "TextDecoder",
      "TextEncoder",
      "URL",
      "URLSearchParams",
      "atob",
      "btoa",
    ] as const
  ) {
    const value = hostGlobals[name];
    if (value !== undefined) {
      globals[name] = freezeSandboxValue(value);
    }
  }

  globals.console = createSafeConsoleGlobal();

  // `__cfReg({ symbol: value })` registers a module's hoisted builder artifacts
  // for content-addressed `{ identity, symbol }` lookup. The ESM module loader
  // supplies a real, identity-bound registrar as the module factory's 4th
  // parameter (which shadows this global inside that wrapper). On the legacy/AMD
  // bundle path identity addressing is not wired, so this global is a no-op — it
  // only needs to exist so a transformer-emitted `__cfReg({…})` call resolves
  // rather than throwing a ReferenceError.
  globals.__cfReg = freezeSandboxValue(() => undefined);

  return globals;
}

export function createModuleCompartmentGlobals(
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...createCompatibilityGlobals(),
    ...freezeSandboxRecordValues(extras),
  };
}

export function createCallbackCompartmentGlobals(
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return createModuleCompartmentGlobals(extras);
}

export function createSafeConsoleGlobal(
  consoleLike:
    | Record<string, unknown>
    | Console
    | undefined = globalThis.console as unknown as
      | Record<string, unknown>
      | undefined,
): Record<string, unknown> {
  const safeConsole: Record<string, unknown> = {};

  for (const methodName of CONSOLE_METHOD_NAMES) {
    const method = consoleLike?.[methodName];
    safeConsole[methodName] = typeof method === "function"
      ? freezeSandboxValue(method.bind(consoleLike))
      : EMPTY_CONSOLE_METHOD;
  }

  return freezeSandboxValue(safeConsole);
}
