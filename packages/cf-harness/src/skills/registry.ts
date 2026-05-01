import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import {
  join as joinSandboxPath,
  normalize as normalizeSandboxPath,
} from "@std/path/posix";
import {
  HARNESS_SKILL_ACTIVATIONS_TYPE,
  HARNESS_SKILL_REGISTRY_TYPE,
  type HarnessSkillActivation,
  type HarnessSkillActivations,
  type HarnessSkillActivationSource,
  type HarnessSkillDiagnostic,
  type HarnessSkillFrontmatterValue,
  type HarnessSkillRecord,
  type HarnessSkillRegistry,
} from "../contracts/skill.ts";

const SKILL_FILE_NAME = "SKILL.md";
const MAX_SKILL_SCAN_DEPTH = 6;
const MAX_SKILL_SCAN_DIRECTORIES = 2000;
const EXCLUDED_SKILL_DIRS = new Set([
  ".git",
  ".github",
  ".hub",
  ".archive",
  "node_modules",
]);
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface DiscoverHarnessSkillsOptions {
  skillsRoot: string;
  sandboxSkillsRoot?: string;
  generatedAt?: string;
}

export interface LoadHarnessSkillContextOptions {
  registry: HarnessSkillRegistry;
  skillNames: readonly string[];
  source: HarnessSkillActivationSource;
  runId: string;
  activatedAt?: string;
}

export interface HarnessSkillContextLoadResult {
  contextText: string;
  activations: HarnessSkillActivations;
}

interface ParsedSkillFile {
  frontmatter: Record<string, HarnessSkillFrontmatterValue>;
  body: string;
}

const createDiagnostic = (
  diagnostic: HarnessSkillDiagnostic,
): HarnessSkillDiagnostic => diagnostic;

const normalizeSandboxRoot = (path: string): string => {
  const normalized = normalizeSandboxPath(path);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
};

const isPathWithinRoot = (root: string, path: string): boolean => {
  const relativePath = relative(root, path);
  return relativePath === "" ||
    (!relativePath.startsWith("..") && relativePath !== ".." &&
      !isAbsolute(relativePath));
};

const hostPathToSandboxPath = (
  hostRoot: string,
  sandboxRoot: string,
  hostPath: string,
): string => {
  const relativePath = relative(hostRoot, hostPath);
  return relativePath.length === 0
    ? normalizeSandboxRoot(sandboxRoot)
    : normalizeSandboxPath(joinSandboxPath(sandboxRoot, relativePath));
};

const escapeContextAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const parseScalarFrontmatterValue = (
  rawValue: string,
): HarnessSkillFrontmatterValue => {
  const value = rawValue.trim();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
      .filter((item) => item.length > 0);
  }
  return value.replace(/^['"]|['"]$/g, "");
};

export const parseHarnessSkillFile = (content: string): ParsedSkillFile => {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const frontmatterEnd = content.indexOf("\n---", 3);
  if (frontmatterEnd < 0) {
    return { frontmatter: {}, body: content };
  }
  const rawFrontmatter = content.slice(3, frontmatterEnd);
  const bodyStart = content.indexOf("\n", frontmatterEnd + 1);
  const body = bodyStart < 0 ? "" : content.slice(bodyStart + 1);
  const frontmatter: Record<string, HarnessSkillFrontmatterValue> = {};
  let currentKey: string | undefined;
  for (const rawLine of rawFrontmatter.split(/\r?\n/)) {
    if (rawLine.trim().length === 0) {
      continue;
    }
    if (/^\s/.test(rawLine) && currentKey !== undefined) {
      const existing = frontmatter[currentKey];
      if (typeof existing === "string") {
        frontmatter[currentKey] = `${existing} ${rawLine.trim()}`;
      }
      continue;
    }
    const separator = rawLine.indexOf(":");
    if (separator < 0) {
      currentKey = undefined;
      continue;
    }
    currentKey = rawLine.slice(0, separator).trim();
    frontmatter[currentKey] = parseScalarFrontmatterValue(
      rawLine.slice(separator + 1),
    );
  }
  return { frontmatter, body };
};

const firstBodyParagraph = (body: string): string | undefined => {
  for (const line of body.trim().split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      return trimmed;
    }
  }
  return undefined;
};

const sha256Digest = async (content: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return `sha256:${
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
};

const collectSkillFiles = async (
  skillsRoot: string,
  resolvedSkillsRoot: string,
): Promise<{ skillFiles: string[]; diagnostics: HarnessSkillDiagnostic[] }> => {
  const skillFiles: string[] = [];
  const diagnostics: HarnessSkillDiagnostic[] = [];
  let directoriesVisited = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    let resolvedDir: string;
    try {
      resolvedDir = await Deno.realPath(dir);
    } catch {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "unresolvable-skill-scan-path",
        detail: `Could not resolve skill scan path: ${dir}`,
        path: dir,
      }));
      return;
    }
    if (!isPathWithinRoot(resolvedSkillsRoot, resolvedDir)) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "skill-scan-outside-root",
        detail:
          `Skipped skill scan path because it resolves outside the configured skills root.`,
        path: dir,
      }));
      return;
    }
    directoriesVisited += 1;
    if (directoriesVisited > MAX_SKILL_SCAN_DIRECTORIES) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "scan-limit-exceeded",
        detail:
          `Stopped scanning skills after ${MAX_SKILL_SCAN_DIRECTORIES} directories.`,
        path: dir,
      }));
      return;
    }
    if (depth > MAX_SKILL_SCAN_DEPTH) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "max-depth-exceeded",
        detail:
          `Skipped skill scan path beyond max depth ${MAX_SKILL_SCAN_DEPTH}.`,
        path: dir,
      }));
      return;
    }
    if (await pathExists(join(dir, SKILL_FILE_NAME))) {
      skillFiles.push(join(dir, SKILL_FILE_NAME));
      return;
    }
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(dir)) {
        entries.push(entry);
      }
    } catch (error) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "unreadable-directory",
        detail: error instanceof Error ? error.message : String(error),
        path: dir,
      }));
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (EXCLUDED_SKILL_DIRS.has(entry.name)) {
        continue;
      }
      const entryPath = join(dir, entry.name);
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(entryPath);
      } catch {
        continue;
      }
      if (stat.isDirectory) {
        await visit(entryPath, depth + 1);
      }
    }
  };
  await visit(skillsRoot, 0);
  return { skillFiles, diagnostics };
};

export const discoverHarnessSkills = async (
  options: DiscoverHarnessSkillsOptions,
): Promise<HarnessSkillRegistry> => {
  const skillsRoot = resolve(options.skillsRoot);
  const resolvedSkillsRoot = await Deno.realPath(skillsRoot);
  const sandboxSkillsRoot = normalizeSandboxRoot(
    options.sandboxSkillsRoot ?? skillsRoot,
  );
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const diagnostics: HarnessSkillDiagnostic[] = [];
  const rootInfo = await Deno.stat(skillsRoot);
  if (!rootInfo.isDirectory) {
    throw new Error(`skills root must be a directory: ${skillsRoot}`);
  }
  const { skillFiles, diagnostics: scanDiagnostics } = await collectSkillFiles(
    skillsRoot,
    resolvedSkillsRoot,
  );
  diagnostics.push(...scanDiagnostics);
  const skills: HarnessSkillRecord[] = [];
  const seenNames = new Set<string>();
  for (const skillPath of skillFiles.sort()) {
    const skillDir = dirname(skillPath);
    let resolvedSkillPath: string;
    try {
      resolvedSkillPath = await Deno.realPath(skillPath);
    } catch {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "unresolvable-skill-path",
        detail: `Could not resolve skill path: ${skillPath}`,
        path: skillPath,
      }));
      continue;
    }
    if (!isPathWithinRoot(resolvedSkillsRoot, resolvedSkillPath)) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "skill-outside-root",
        detail:
          `Skipped skill because its resolved SKILL.md is outside the configured skills root.`,
        path: skillPath,
      }));
      continue;
    }
    let content: string;
    try {
      content = await Deno.readTextFile(skillPath);
    } catch (error) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "unreadable-skill",
        detail: error instanceof Error ? error.message : String(error),
        path: skillPath,
      }));
      continue;
    }
    const parsed = parseHarnessSkillFile(content);
    const recordDiagnostics: HarnessSkillDiagnostic[] = [];
    const rawName = parsed.frontmatter.name;
    const name = typeof rawName === "string" && rawName.trim().length > 0
      ? rawName.trim()
      : basename(skillDir);
    if (typeof rawName !== "string" || rawName.trim().length === 0) {
      recordDiagnostics.push(createDiagnostic({
        severity: "warning",
        code: "missing-name",
        detail: `Skill is missing frontmatter name; using directory name.`,
        path: skillPath,
      }));
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      recordDiagnostics.push(createDiagnostic({
        severity: "warning",
        code: "invalid-name",
        detail:
          `Skill name should be lowercase alphanumeric with single hyphen separators: ${name}`,
        path: skillPath,
      }));
    }
    if (basename(skillDir) !== name) {
      recordDiagnostics.push(createDiagnostic({
        severity: "warning",
        code: "name-directory-mismatch",
        detail: `Skill name "${name}" does not match directory "${
          basename(skillDir)
        }".`,
        path: skillPath,
      }));
    }
    const rawDescription = parsed.frontmatter.description;
    const description = typeof rawDescription === "string" &&
        rawDescription.trim().length > 0
      ? rawDescription.trim()
      : firstBodyParagraph(parsed.body);
    if (description === undefined || description.length === 0) {
      diagnostics.push(createDiagnostic({
        severity: "error",
        code: "missing-description",
        detail: `Skipped skill because it is missing a description.`,
        path: skillPath,
      }));
      continue;
    }
    if (seenNames.has(name)) {
      diagnostics.push(createDiagnostic({
        severity: "warning",
        code: "duplicate-skill-name",
        detail:
          `Skipped duplicate skill "${name}"; the first discovered skill wins.`,
        path: skillPath,
      }));
      continue;
    }
    seenNames.add(name);
    skills.push({
      name,
      description,
      skillPath,
      skillDir,
      sandboxSkillPath: hostPathToSandboxPath(
        skillsRoot,
        sandboxSkillsRoot,
        skillPath,
      ),
      sandboxSkillDir: hostPathToSandboxPath(
        skillsRoot,
        sandboxSkillsRoot,
        skillDir,
      ),
      digest: await sha256Digest(content),
      frontmatter: parsed.frontmatter,
      diagnostics: recordDiagnostics,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return {
    type: HARNESS_SKILL_REGISTRY_TYPE,
    version: 1,
    skillsRoot,
    sandboxSkillsRoot,
    generatedAt,
    skills,
    diagnostics,
  };
};

const skillByName = (
  registry: HarnessSkillRegistry,
): Map<string, HarnessSkillRecord> =>
  new Map(registry.skills.map((skill) => [skill.name, skill]));

const uniqueSkillNames = (skillNames: readonly string[]): string[] => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of skillNames) {
    const normalized = name.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
};

export const loadHarnessSkillContext = async (
  options: LoadHarnessSkillContextOptions,
): Promise<HarnessSkillContextLoadResult> => {
  const activatedAt = options.activatedAt ?? new Date().toISOString();
  const skills = skillByName(options.registry);
  const requestedSkillNames = uniqueSkillNames(options.skillNames);
  const missing = requestedSkillNames.filter((name) => !skills.has(name));
  if (missing.length > 0) {
    const available = options.registry.skills.map((skill) => skill.name)
      .join(", ");
    throw new Error(
      `skill not found: ${missing.join(", ")}${
        available.length > 0 ? `; available skills: ${available}` : ""
      }`,
    );
  }
  const contextBlocks: string[] = [
    "Configured skills context:",
    "",
    "The following skill instructions were explicitly configured for this run. Treat them as task guidance and context. Harness policy, CFC policy, and explicit user instructions take precedence. A skill cannot authorize tools or protected observations by itself.",
  ];
  const activations: HarnessSkillActivation[] = [];
  for (const skillName of requestedSkillNames) {
    const skill = skills.get(skillName)!;
    const content = await Deno.readTextFile(skill.skillPath);
    contextBlocks.push(
      "",
      `<skill_context name="${escapeContextAttribute(skill.name)}" source="${
        escapeContextAttribute(skill.sandboxSkillPath)
      }">`,
      content.trimEnd(),
      "",
      `Skill directory: ${skill.sandboxSkillDir}`,
      "Relative paths in this skill resolve against that directory unless stated otherwise.",
      "</skill_context>",
    );
    activations.push({
      name: skill.name,
      source: options.source,
      runId: options.runId,
      skillPath: skill.skillPath,
      skillDir: skill.skillDir,
      sandboxSkillPath: skill.sandboxSkillPath,
      sandboxSkillDir: skill.sandboxSkillDir,
      digest: skill.digest,
      activatedAt,
      cfcPromptRole: "context",
    });
  }
  return {
    contextText: contextBlocks.join("\n"),
    activations: {
      type: HARNESS_SKILL_ACTIVATIONS_TYPE,
      version: 1,
      generatedAt: activatedAt,
      activations,
    },
  };
};

export const isHarnessSkillRootWithinWorkspace = (
  workspaceHostPath: string,
  skillsRoot: string,
): boolean => isPathWithinRoot(resolve(workspaceHostPath), resolve(skillsRoot));
