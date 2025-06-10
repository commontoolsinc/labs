// Minimal subset of dom APIs to support our runtime environment

/**
 * The **`URL`** interface is used to parse, construct, normalize, and encode URL.
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL)
 */
interface URL {
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/hash) */
  hash: string;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/host) */
  host: string;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/hostname) */
  hostname: string;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/href) */
  href: string;
  toString(): string;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/origin) */
  readonly origin: string;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/password) */
  password: string;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/pathname) */
  pathname: string;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/port) */
  port: string;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/protocol) */
  protocol: string;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/search) */
  search: string;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/searchParams) */
  readonly searchParams: URLSearchParams;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/username) */
  username: string;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/toJSON) */
  toJSON(): string;
}

declare var URL: {
  prototype: URL;
  new (url: string | URL, base?: string | URL): URL;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/canParse_static) */
  canParse(url: string | URL, base?: string | URL): boolean;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/createObjectURL_static) */
  createObjectURL(obj: Blob | MediaSource): string;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/parse_static) */
  parse(url: string | URL, base?: string | URL): URL | null;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/URL/revokeObjectURL_static) */
  revokeObjectURL(url: string): void;
};

/** The **`console`** object provides access to the debugging console (e.g., the Web console in Firefox). */
/**
 * The **`console`** object provides access to the debugging console (e.g., the Web console in Firefox).
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/console)
 */
interface Console {
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/assert_static) */
  assert(condition?: boolean, ...data: any[]): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/clear_static) */
  clear(): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/count_static) */
  count(label?: string): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/countReset_static) */
  countReset(label?: string): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/debug_static) */
  debug(...data: any[]): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/dir_static) */
  dir(item?: any, options?: any): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/dirxml_static) */
  dirxml(...data: any[]): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/error_static) */
  error(...data: any[]): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/group_static) */
  group(...data: any[]): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/groupCollapsed_static) */
  groupCollapsed(...data: any[]): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/groupEnd_static) */
  groupEnd(): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/info_static) */
  info(...data: any[]): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/log_static) */
  log(...data: any[]): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/table_static) */
  table(tabularData?: any, properties?: string[]): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/time_static) */
  time(label?: string): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/timeEnd_static) */
  timeEnd(label?: string): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/timeLog_static) */
  timeLog(label?: string, ...data: any[]): void;
  timeStamp(label?: string): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/trace_static) */
  trace(...data: any[]): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/warn_static) */
  warn(...data: any[]): void;
}

declare var console: Console;

// Stubbed for now
interface RequestInit {}
