export interface BrowserHostCommandPolicyResult {
  allowed: boolean;
  reason?: string;
  plan?: BrowserHostCommandPlan;
}

export interface BrowserHostCommandPlan {
  argv: readonly string[];
  workspacePathArgs: readonly string[];
}

export const BROWSER_HOST_COMMAND_DENIED_EXIT_CODE = 126;
export const BROWSER_HOST_COMMAND_DENIED_PREFIX =
  "bash-no-sandbox command denied";

const AGENT_BROWSER_COMMAND = "agent-browser";
const MAX_FIND_DEPTH = 5;

export const validateBrowserHostCommand = (
  command: string,
): BrowserHostCommandPolicyResult => {
  const parsed = parseSimpleShellCommand(command);
  if (parsed.error !== undefined) {
    return deny(parsed.error);
  }
  const [commandName, ...args] = parsed.tokens;
  switch (commandName) {
    case AGENT_BROWSER_COMMAND:
      return validateAgentBrowserCommand(args);
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
): BrowserHostCommandPolicyResult => {
  for (const arg of args) {
    const flag = normalizeLongFlag(arg);
    if (
      DISALLOWED_AGENT_BROWSER_FLAGS.has(flag) ||
      isDisallowedAgentBrowserShortFlag(arg)
    ) {
      return deny(`agent-browser flag ${flag} is not allowed from cf-harness`);
    }
  }

  const command = findAgentBrowserSubcommand(args);
  if (command !== undefined) {
    if (DISALLOWED_AGENT_BROWSER_COMMANDS.has(command.name)) {
      return deny(
        `agent-browser ${command.name} is not allowed from cf-harness`,
      );
    }
    if (
      command.name === "open" &&
      args.slice(command.index + 1).some((arg) => /^file:/i.test(arg))
    ) {
      return deny("agent-browser open file: URLs are not allowed");
    }
  }
  return allow([AGENT_BROWSER_COMMAND, ...args]);
};

const DISALLOWED_AGENT_BROWSER_COMMANDS = new Set([
  "connect",
  "download",
  "eval",
  "install",
  "pdf",
  "profiler",
  "record",
  "screenshot",
  "trace",
  "upload",
]);

const DISALLOWED_AGENT_BROWSER_FLAGS = new Set([
  "--allow-file-access",
  "--args",
  "--auto-connect",
  "--cdp",
  "--config",
  "--device",
  "--executable-path",
  "--extension",
  "--headers",
  "--ignore-https-errors",
  "--profile",
  "--provider",
  "--proxy",
  "--proxy-bypass",
  "--state",
  "--user-agent",
]);

const AGENT_BROWSER_VALUE_FLAGS = new Set([
  "--session",
  "--session-name",
]);

const normalizeLongFlag = (arg: string): string => {
  if (!arg.startsWith("--")) {
    return arg;
  }
  const equalsIndex = arg.indexOf("=");
  return equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
};

const isDisallowedAgentBrowserShortFlag = (arg: string): boolean =>
  arg === "-p" || arg.startsWith("-p=") || /^-p[^-]/.test(arg);

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
