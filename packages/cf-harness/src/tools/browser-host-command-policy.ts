export interface BrowserHostCommandPolicyResult {
  allowed: boolean;
  reason?: string;
  plan?: BrowserHostCommandPlan;
}

export interface BrowserHostCommandPlan {
  argv: readonly string[];
  workspacePathArgs: readonly string[];
}

export interface BrowserHostCommandPolicyOptions {
  browserAccessCdpUrl?: string;
}

export const BROWSER_HOST_COMMAND_DENIED_EXIT_CODE = 126;
export const BROWSER_HOST_COMMAND_DENIED_PREFIX =
  "bash-no-sandbox command denied";

const AGENT_BROWSER_COMMAND = "agent-browser";
const MAX_FIND_DEPTH = 5;
const MAX_WAIT_MS = 30_000;

export const validateBrowserHostCommand = (
  command: string,
  options: BrowserHostCommandPolicyOptions = {},
): BrowserHostCommandPolicyResult => {
  const parsed = parseSimpleShellCommand(command);
  if (parsed.error !== undefined) {
    return deny(parsed.error);
  }
  const [commandName, ...args] = parsed.tokens;
  switch (commandName) {
    case AGENT_BROWSER_COMMAND:
      return validateAgentBrowserCommand(args, options);
    case "command":
      return validateCommandBuiltin(args);
    case "find":
      return validateFindCommand(args);
    case "ls":
      return validateLsCommand(args);
    case "pwd":
      return args.length === 0
        ? allow(["pwd"])
        : deny("pwd does not accept arguments in the browser host profile");
    case "which":
      return validateWhichCommand(args);
    default:
      return deny(
        `${
          commandName ?? "empty command"
        } is not allowed in the browser host profile`,
      );
  }
};

const allow = (
  argv: readonly string[],
  workspacePathArgs: readonly string[] = [],
): BrowserHostCommandPolicyResult => ({
  allowed: true,
  plan: {
    argv: [...argv],
    workspacePathArgs: [...workspacePathArgs],
  },
});

const deny = (reason: string): BrowserHostCommandPolicyResult => ({
  allowed: false,
  reason,
});

const validateAgentBrowserCommand = (
  args: readonly string[],
  options: BrowserHostCommandPolicyOptions,
): BrowserHostCommandPolicyResult => {
  const expectedCdpOrigin = normalizeCdpOrigin(options.browserAccessCdpUrl);
  if (
    options.browserAccessCdpUrl !== undefined && expectedCdpOrigin === undefined
  ) {
    return deny("configured Browser Access CDP endpoint is invalid");
  }
  const cdpEndpoint = extractAgentBrowserCdpEndpoint(args, expectedCdpOrigin);
  if (cdpEndpoint.error !== undefined) {
    return deny(cdpEndpoint.error);
  }

  const command = findAgentBrowserSubcommand(args);
  if (command === undefined) {
    return args.length === 1 && args[0] === "--help"
      ? allow([AGENT_BROWSER_COMMAND, "--help"])
      : deny("agent-browser command must be explicitly allowlisted");
  }
  const globalArgsError = validateAgentBrowserGlobalArgs(args, command.index);
  if (globalArgsError !== undefined) {
    return deny(globalArgsError);
  }
  const commandArgs = args.slice(command.index + 1);
  if (AGENT_BROWSER_LOCAL_COMMANDS.has(command.name)) {
    return commandArgs.length === 0
      ? allow([AGENT_BROWSER_COMMAND, ...args])
      : deny(`agent-browser ${command.name} does not accept arguments here`);
  }
  if (!AGENT_BROWSER_PAGE_COMMANDS.has(command.name)) {
    return deny(`agent-browser ${command.name} is not allowlisted`);
  }
  if (expectedCdpOrigin === undefined) {
    return deny(
      "agent-browser page commands require a Browser Access lease endpoint",
    );
  }
  if (cdpEndpoint.endpoint === undefined) {
    return deny(
      "agent-browser page commands must use --cdp with the Browser Access lease endpoint",
    );
  }
  const commandError = validateAgentBrowserPageCommand(
    command.name,
    commandArgs,
  );
  if (commandError !== undefined) {
    return deny(commandError);
  }
  return allow([AGENT_BROWSER_COMMAND, ...args]);
};

const AGENT_BROWSER_LOCAL_COMMANDS = new Set([
  "help",
  "version",
]);

const AGENT_BROWSER_PAGE_COMMANDS = new Set([
  "check",
  "click",
  "fill",
  "get",
  "open",
  "press",
  "select",
  "snapshot",
  "type",
  "wait",
]);

const AGENT_BROWSER_VALUE_FLAGS = new Set([
  "--cdp",
]);

const ALLOWED_CDP_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "[::1]",
  "host.docker.internal",
  "localhost",
]);

const extractAgentBrowserCdpEndpoint = (
  args: readonly string[],
  expectedCdpOrigin: string | undefined,
): { endpoint?: string; error?: undefined } | {
  endpoint?: undefined;
  error: string;
} => {
  let endpoint: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (normalizeLongFlag(arg) !== "--cdp") {
      continue;
    }
    if (endpoint !== undefined) {
      return { error: "agent-browser --cdp may only be supplied once" };
    }
    const equalsIndex = arg.indexOf("=");
    const value = equalsIndex === -1
      ? args[index + 1]
      : arg.slice(equalsIndex + 1);
    if (value === undefined || value === "") {
      return { error: "agent-browser --cdp requires a local endpoint value" };
    }
    const endpointError = validateAgentBrowserCdpEndpoint(
      value,
      expectedCdpOrigin,
    );
    if (endpointError !== undefined) {
      return { error: endpointError };
    }
    endpoint = value;
    if (equalsIndex === -1) {
      index += 1;
    }
  }
  return { endpoint };
};

const validateAgentBrowserCdpEndpoint = (
  endpoint: string,
  expectedCdpOrigin: string | undefined,
): string | undefined => {
  const origin = normalizeCdpOrigin(endpoint);
  if (origin === undefined) {
    return "agent-browser --cdp must be an http:// local origin with an explicit port";
  }
  if (expectedCdpOrigin !== undefined && origin !== expectedCdpOrigin) {
    return "agent-browser --cdp must match the Browser Access lease endpoint";
  }
  return undefined;
};

export const normalizeCdpOrigin = (
  endpoint: string | undefined,
): string | undefined => {
  if (endpoint === undefined) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") {
    return undefined;
  }
  if (!ALLOWED_CDP_HOSTS.has(url.hostname)) {
    return undefined;
  }
  if (url.port === "") {
    return undefined;
  }
  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  return url.origin;
};

const normalizeLongFlag = (arg: string): string => {
  if (!arg.startsWith("--")) {
    return arg;
  }
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
};

const findAgentBrowserSubcommand = (
  args: readonly string[],
): { name: string; index: number } | undefined => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("-")) {
      const flag = normalizeLongFlag(arg);
      if (AGENT_BROWSER_VALUE_FLAGS.has(flag) && !arg.includes("=")) {
        index += 1;
      }
      continue;
    }
    return { name: arg, index };
  }
  return undefined;
};

const validateAgentBrowserGlobalArgs = (
  args: readonly string[],
  commandIndex: number,
): string | undefined => {
  for (let index = 0; index < commandIndex; index += 1) {
    const arg = args[index]!;
    const flag = normalizeLongFlag(arg);
    if (flag !== "--cdp") {
      return `agent-browser global flag ${flag} is not allowlisted`;
    }
    if (!arg.includes("=")) {
      index += 1;
    }
  }
  return undefined;
};

const validateAgentBrowserPageCommand = (
  commandName: string,
  args: readonly string[],
): string | undefined => {
  switch (commandName) {
    case "open":
      return validateAgentBrowserOpen(args);
    case "snapshot":
      return validateAgentBrowserSnapshot(args);
    case "get":
      return validateAgentBrowserGet(args);
    case "wait":
      return validateAgentBrowserWait(args);
    case "click":
    case "check":
      return validateAgentBrowserRefCommand(commandName, args, 1);
    case "fill":
    case "type":
    case "select":
      return validateAgentBrowserRefCommand(commandName, args, 2);
    case "press":
      return validateAgentBrowserPress(args);
    default:
      return `agent-browser ${commandName} is not allowlisted`;
  }
};

const validateAgentBrowserOpen = (
  args: readonly string[],
): string | undefined => {
  if (args.length !== 1) {
    return "agent-browser open requires exactly one URL";
  }
  const url = args[0]!;
  if (!/^https?:\/\//i.test(url)) {
    return "agent-browser open only allows http(s) URLs";
  }
  return /^file:/i.test(url)
    ? "agent-browser open file: URLs are not allowed"
    : undefined;
};

const validateAgentBrowserSnapshot = (
  args: readonly string[],
): string | undefined => {
  if (args.length === 0) {
    return undefined;
  }
  return args.length === 1 && args[0] === "-i"
    ? undefined
    : "agent-browser snapshot only allows the optional -i flag";
};

const validateAgentBrowserGet = (
  args: readonly string[],
): string | undefined => {
  const [kind, target, ...extra] = args;
  if (kind === "title" || kind === "url") {
    return target === undefined && extra.length === 0
      ? undefined
      : `agent-browser get ${kind} does not accept arguments here`;
  }
  if (kind === "text") {
    return extra.length === 0 && target !== undefined
      ? undefined
      : "agent-browser get text requires exactly one target";
  }
  return "agent-browser get only allows title, url, or text";
};

const validateAgentBrowserWait = (
  args: readonly string[],
): string | undefined => {
  if (args.length === 1) {
    const target = args[0]!;
    if (/^\d+$/.test(target)) {
      const ms = Number.parseInt(target, 10);
      return ms >= 0 && ms <= MAX_WAIT_MS
        ? undefined
        : `agent-browser wait milliseconds must be between 0 and ${MAX_WAIT_MS}`;
    }
    return target.startsWith("@")
      ? undefined
      : "agent-browser wait target must be a ref or bounded milliseconds";
  }
  if (args.length === 2 && args[0] === "--load") {
    return ["domcontentloaded", "load", "networkidle"].includes(args[1]!)
      ? undefined
      : "agent-browser wait --load state is not allowlisted";
  }
  if (args.length === 2 && args[0] === "--url") {
    return args[1] !== "" && !/^file:/i.test(args[1]!)
      ? undefined
      : "agent-browser wait --url requires a non-file pattern";
  }
  return "agent-browser wait arguments are not allowlisted";
};

const validateAgentBrowserRefCommand = (
  commandName: string,
  args: readonly string[],
  expectedLength: number,
): string | undefined => {
  if (args.length !== expectedLength) {
    return `agent-browser ${commandName} requires ${expectedLength} argument(s)`;
  }
  const ref = args[0]!;
  return ref.startsWith("@")
    ? undefined
    : `agent-browser ${commandName} target must be an interactive ref`;
};

const validateAgentBrowserPress = (
  args: readonly string[],
): string | undefined => {
  if (args.length !== 1 || args[0] === "") {
    return "agent-browser press requires exactly one key";
  }
  return /^[A-Za-z0-9_+.-]+$/.test(args[0]!)
    ? undefined
    : "agent-browser press key contains unsupported characters";
};

const validateCommandBuiltin = (
  args: readonly string[],
): BrowserHostCommandPolicyResult =>
  args.length === 2 && args[0] === "-v" && args[1] === AGENT_BROWSER_COMMAND
    ? allow(["which", AGENT_BROWSER_COMMAND])
    : deny("only command -v agent-browser is allowed");

const validateWhichCommand = (
  args: readonly string[],
): BrowserHostCommandPolicyResult =>
  args.length === 1 && args[0] === AGENT_BROWSER_COMMAND
    ? allow(["which", AGENT_BROWSER_COMMAND])
    : deny("only which agent-browser is allowed");

const validateLsCommand = (
  args: readonly string[],
): BrowserHostCommandPolicyResult => {
  const workspacePathArgs: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!/^-[alhF1d]+$/.test(arg)) {
        return deny(`ls flag ${arg} is not allowed`);
      }
      continue;
    }
    if (!isSafeWorkspaceRelativePath(arg)) {
      return deny(`ls path ${arg} must stay within the workspace`);
    }
    workspacePathArgs.push(arg);
  }
  return allow(["ls", ...args], workspacePathArgs);
};

const validateFindCommand = (
  args: readonly string[],
): BrowserHostCommandPolicyResult => {
  if (args.length === 0) {
    return deny("find must include a workspace-relative search path");
  }
  let sawSearchPath = false;
  let sawMaxDepth = false;
  let index = 0;
  const workspacePathArgs: string[] = [];
  while (index < args.length) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) {
      if (sawMaxDepth) {
        return deny(`unexpected find argument ${arg}`);
      }
      if (!isSafeWorkspaceRelativePath(arg)) {
        return deny(`find path ${arg} must stay within the workspace`);
      }
      workspacePathArgs.push(arg);
      sawSearchPath = true;
      index += 1;
      continue;
    }
    switch (arg) {
      case "-maxdepth": {
        const depth = parseBoundedInteger(args[index + 1]);
        if (depth === undefined || depth > MAX_FIND_DEPTH) {
          return deny(
            `find -maxdepth must be an integer from 0 to ${MAX_FIND_DEPTH}`,
          );
        }
        sawMaxDepth = true;
        index += 2;
        break;
      }
      case "-mindepth": {
        const depth = parseBoundedInteger(args[index + 1]);
        if (depth === undefined || depth > MAX_FIND_DEPTH) {
          return deny(
            `find -mindepth must be an integer from 0 to ${MAX_FIND_DEPTH}`,
          );
        }
        index += 2;
        break;
      }
      case "-type": {
        const type = args[index + 1];
        if (type !== "f" && type !== "d" && type !== "l") {
          return deny("find -type must be one of f, d, or l");
        }
        index += 2;
        break;
      }
      case "-name":
      case "-iname": {
        const pattern = args[index + 1];
        if (pattern === undefined || pattern === "" || pattern.includes("/")) {
          return deny(`${arg} must use a non-empty basename pattern`);
        }
        index += 2;
        break;
      }
      case "-path":
      case "-ipath": {
        const pattern = args[index + 1];
        if (pattern === undefined || !isSafeWorkspaceRelativePattern(pattern)) {
          return deny(`${arg} pattern must stay within the workspace`);
        }
        index += 2;
        break;
      }
      case "-print":
        index += 1;
        break;
      default:
        return deny(`find predicate ${arg} is not allowed`);
    }
  }
  if (!sawSearchPath) {
    return deny("find must include a workspace-relative search path");
  }
  if (!sawMaxDepth) {
    return deny("find must include -maxdepth");
  }
  return allow(["find", ...args], workspacePathArgs);
};

const parseBoundedInteger = (input: string | undefined): number | undefined => {
  if (input === undefined || !/^\d+$/.test(input)) {
    return undefined;
  }
  return Number.parseInt(input, 10);
};

const isSafeWorkspaceRelativePattern = (pattern: string): boolean =>
  pattern !== "" &&
  !pattern.startsWith("/") &&
  !pattern.startsWith("~") &&
  !pathSegments(pattern).includes("..");

const isSafeWorkspaceRelativePath = (path: string): boolean =>
  path === "." || path === "./" ||
  (path !== "" &&
    !path.startsWith("-") &&
    !path.startsWith("/") &&
    !path.startsWith("~") &&
    !path.includes("*") &&
    !path.includes("?") &&
    !pathSegments(path).includes(".."));

const pathSegments = (path: string): string[] =>
  path.split("/").filter((segment) => segment.length > 0);

type SimpleShellParseResult =
  | { tokens: string[]; error?: undefined }
  | { tokens?: undefined; error: string };

const parseSimpleShellCommand = (command: string): SimpleShellParseResult => {
  const input = command.trim();
  if (input === "") {
    return { error: "empty commands are not allowed" };
  }
  if (/[\n\r\0]/.test(input)) {
    return { error: "multi-line commands are not allowed" };
  }
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else if (isDisallowedShellExpansionSyntax(char)) {
        return {
          error: "shell substitutions and escaped commands are not allowed",
        };
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (isDisallowedUnquotedShellExpansionSyntax(char)) {
      return {
        error:
          "unquoted shell expansion syntax is not allowed; quote literal selectors, URLs, and patterns",
      };
    }
    if (isDisallowedShellSyntax(char)) {
      return {
        error:
          "shell operators, substitutions, redirects, and escaped commands are not allowed",
      };
    }
    current += char;
  }
  if (quote !== undefined) {
    return { error: "unterminated quoted argument" };
  }
  if (current !== "") {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    return { error: "empty commands are not allowed" };
  }
  return { tokens };
};

const isDisallowedShellExpansionSyntax = (char: string): boolean =>
  char === "`" || char === "$" || char === "\\";

const isDisallowedUnquotedShellExpansionSyntax = (char: string): boolean =>
  char === "{" ||
  char === "}" ||
  char === "[" ||
  char === "]" ||
  char === "*" ||
  char === "?";

const isDisallowedShellSyntax = (char: string): boolean =>
  char === "|" ||
  char === "&" ||
  char === ";" ||
  char === "<" ||
  char === ">" ||
  char === "(" ||
  char === ")" ||
  isDisallowedShellExpansionSyntax(char) ||
  char === "#";
