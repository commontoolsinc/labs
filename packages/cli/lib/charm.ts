import { createSession, isDID, Session } from "@commontools/identity";
import { ensureDir } from "@std/fs";
import { loadIdentity } from "./identity.ts";
import {
  isStream,
  Runtime,
  RuntimeProgram,
  type Stream,
  UI,
  VNode,
} from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache";
import { charmId, CharmManager, extractUserCode } from "@commontools/charm";
import { CharmsController } from "@commontools/charm/ops";
import { dirname, join } from "@std/path";
import { FileSystemProgramResolver } from "@commontools/js-compiler";
import { setLLMUrl } from "@commontools/llm";
import { isObject } from "@commontools/utils/types";

export interface EntryConfig {
  mainPath: string;
  mainExport?: string;
  rootPath?: string;
}

export interface SpaceConfig {
  apiUrl: string;
  space: string;
  identity: string;
}

export interface CharmConfig extends SpaceConfig {
  charm: string;
}

async function makeSession(config: SpaceConfig): Promise<Session> {
  const identity = await loadIdentity(config.identity);
  if (isDID(config.space)) {
    return createSession({ identity, spaceDid: config.space });
  } else {
    return createSession({ identity, spaceName: config.space });
  }
}

export async function loadManager(config: SpaceConfig): Promise<CharmManager> {
  setLLMUrl(config.apiUrl);
  const session = await makeSession(config);
  // Use a const ref object so we can assign later while keeping const binding
  const charmManagerRef: { current?: CharmManager } = {};
  const runtime = new Runtime({
    apiUrl: new URL(config.apiUrl),
    storageManager: StorageManager.open({
      as: session.as,
      address: new URL("/api/storage/memory", config.apiUrl),
      spaceIdentity: session.spaceIdentity,
    }),
    navigateCallback: (target) => {
      try {
        const id = charmId(target);
        if (!id) {
          console.error("navigateTo: target missing charm id");
          return;
        }
        // Emit greppable line immediately so scripts can capture without waiting
        console.log(`navigateTo new charm id ${id}`);
        // Best-effort: ensure charm is present in list
        runtime.storageManager.synced().then(async () => {
          try {
            const mgr = charmManagerRef.current!;
            const charmsCell = await mgr.getCharms();
            const list = charmsCell.get();
            const exists = list.some((c) => charmId(c) === id);
            if (!exists) {
              await mgr.add([target]);
            }
          } catch (e) {
            console.error("navigateTo add error:", e);
          }
        }).catch((_err) => {
          // ignore; we already emitted the id
        });
      } catch (e) {
        console.error("navigateTo callback error:", e);
      }
    },
  });

  if (!(await runtime.healthCheck())) {
    throw new Error(`Could not connect to "${config.apiUrl.toString()}".`);
  }

  const charmManager = new CharmManager(session, runtime);
  charmManagerRef.current = charmManager;
  await charmManager.synced();
  return charmManager;
}

async function getProgramFromFile(
  manager: CharmManager,
  entry: EntryConfig,
): Promise<RuntimeProgram> {
  const program: RuntimeProgram = await manager.runtime.harness.resolve(
    new FileSystemProgramResolver(entry.mainPath, entry.rootPath),
  );
  if (entry.mainExport) {
    program.mainExport = entry.mainExport;
  }
  return program;
}

// Returns an array of metadata about charms to display.
export async function listCharms(
  config: SpaceConfig,
): Promise<{ id: string; name?: string; recipeName?: string }[]> {
  const manager = await loadManager(config);
  const charms = new CharmsController(manager);
  const allCharms = await charms.getAllCharms();
  return Promise.all(
    allCharms.map(async (charm) => {
      return {
        id: charm.id,
        name: charm.name(),
        recipeName: (await charm.getRecipeMeta()).recipeName,
      };
    }),
  );
}

// Creates a new charm from source code and optional input.
export async function newCharm(
  config: SpaceConfig,
  entry: EntryConfig,
  options?: { start?: boolean },
): Promise<string> {
  const manager = await loadManager(config);
  const charms = new CharmsController(manager);

  // Try to ensure default pattern, but don't fail the entire operation
  try {
    await charms.ensureDefaultPattern();
  } catch (error) {
    console.warn(
      `Warning: Could not initialize default pattern: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    console.warn(
      "Patterns using wish('#mentionable') or wish('#default') may not work.",
    );
    // Continue anyway - user's pattern might not need defaultPattern
  }

  const program = await getProgramFromFile(manager, entry);
  const charm = await charms.create(program, options);

  // Explicitly add the charm to the space's allCharms list
  await manager.add([charm.getCell()]);

  return charm.id;
}

export async function setCharmRecipe(
  config: CharmConfig,
  entry: EntryConfig,
): Promise<void> {
  const manager = await loadManager(config);
  const charms = new CharmsController(manager);
  const charm = await charms.get(config.charm, false);
  if (entry.mainPath.endsWith(".iframe.js")) {
    await charm.setIframeRecipe(entry.mainPath);
  } else {
    await charm.setRecipe(await getProgramFromFile(manager, entry));
  }
}

export async function saveCharmRecipe(
  config: CharmConfig,
  outPath: string,
): Promise<void> {
  await ensureDir(outPath);
  const manager = await loadManager(config);
  const charms = new CharmsController(manager);
  const charm = await charms.get(config.charm, false);
  const meta = await charm.getRecipeMeta();
  const iframeRecipe = await charm.getIframeRecipe();

  if (iframeRecipe) {
    const userCode = extractUserCode(iframeRecipe.src);
    if (!userCode) {
      throw new Error(`No user code found in iframe recipe "${config.charm}".`);
    }
    await Deno.writeTextFile(
      join(outPath, "main.iframe.js"),
      userCode,
    );
  } else if (meta.src) {
    // Write the main source file
    await Deno.writeTextFile(join(outPath, "main.tsx"), meta.src);
  } else if (meta.program) {
    for (const { name, contents } of meta.program.files) {
      if (name[0] !== "/") {
        throw new Error("Ungrounded file in recipe.");
      }
      const outFilePath = join(outPath, name.substring(1));
      await Deno.mkdir(dirname(outFilePath), { recursive: true });
      await Deno.writeTextFile(outFilePath, contents);
    }
  } else {
    throw new Error(
      `Charm "${config.charm}" does not contain a recipe source.`,
    );
  }
}

export async function applyCharmInput(
  config: CharmConfig,
  input: object,
) {
  const manager = await loadManager(config);
  const charms = new CharmsController(manager);
  const charm = await charms.get(config.charm, false);
  await charm.setInput(input);
}

export async function linkCharms(
  config: SpaceConfig,
  sourceCharmId: string,
  sourcePath: (string | number)[],
  targetCharmId: string,
  targetPath: (string | number)[],
  options?: { start?: boolean },
): Promise<void> {
  const manager = await loadManager(config);

  // Ensure default pattern exists (best effort)
  try {
    const charms = new CharmsController(manager);
    await charms.ensureDefaultPattern();
  } catch (error) {
    // Non-fatal, log and continue
    console.warn(
      `Warning: Could not ensure default pattern: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  await manager.link(
    sourceCharmId,
    sourcePath,
    targetCharmId,
    targetPath,
    options,
  );
}

// Constants for charm mapping
const SHORT_ID_LENGTH = 8;

// Types for charm mapping
export interface CharmConnection {
  name: string;
  readingFrom: string[];
  readBy: string[];
}

export type CharmConnectionMap = Map<string, CharmConnection>;

// Helper functions for charm mapping
function createShortId(id: string): string {
  if (id.length <= SHORT_ID_LENGTH * 2 + 3) {
    return id; // Don't truncate if it's already short enough
  }
  const start = id.slice(0, SHORT_ID_LENGTH);
  const end = id.slice(-SHORT_ID_LENGTH);
  return `${start}...${end}`;
}

function createCharmConnection(
  charm: { id: string; name?: string },
  details?: {
    name?: string;
    readingFrom: Array<{ id: string }>;
    readBy: Array<{ id: string }>;
  },
): CharmConnection {
  return {
    name: details?.name || charm.name || createShortId(charm.id),
    readingFrom: details?.readingFrom.map((c) => c.id) || [],
    readBy: details?.readBy.map((c) => c.id) || [],
  };
}

async function buildConnectionMap(
  config: SpaceConfig,
): Promise<CharmConnectionMap> {
  const charms = await listCharms(config);
  const connections: CharmConnectionMap = new Map();

  for (const charm of charms) {
    const charmConfig: CharmConfig = { ...config, charm: charm.id };
    try {
      const details = await inspectCharm(charmConfig);
      connections.set(charm.id, createCharmConnection(charm, details));
    } catch (error) {
      // Skip charms that can't be inspected, but include them with no connections
      console.error(
        `Warning: Could not inspect charm ${charm.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      connections.set(charm.id, createCharmConnection(charm));
    }
  }

  return connections;
}

function generateAsciiMap(connections: CharmConnectionMap): string {
  if (connections.size === 0) {
    return "No charms found in space.";
  }

  let output = "=== Charm Space Map ===\n\n";

  // Sort charms by connection count for better visualization
  const sortedCharms = Array.from(connections.entries()).sort(
    ([, a], [, b]) =>
      (b.readingFrom.length + b.readBy.length) -
      (a.readingFrom.length + a.readBy.length),
  );

  for (const [id, info] of sortedCharms) {
    const shortId = createShortId(id);
    output += `📦 ${info.name} [${shortId}]\n`;

    if (info.readingFrom.length > 0) {
      output += "  ← reads from:\n";
      for (const sourceId of info.readingFrom) {
        const sourceName = connections.get(sourceId)?.name ||
          createShortId(sourceId);
        output += `    • ${sourceName}\n`;
      }
    }

    if (info.readBy.length > 0) {
      output += "  → read by:\n";
      for (const targetId of info.readBy) {
        const targetName = connections.get(targetId)?.name ||
          createShortId(targetId);
        output += `    • ${targetName}\n`;
      }
    }

    if (info.readingFrom.length === 0 && info.readBy.length === 0) {
      output += "  (no connections)\n";
    }

    output += "\n";
  }

  return output;
}

function generateDotMap(connections: CharmConnectionMap): string {
  let dot = "digraph CharmSpace {\n";
  dot += "  rankdir=LR;\n";
  dot += "  node [shape=box];\n\n";

  // Add nodes
  for (const [id, info] of connections) {
    const shortId = createShortId(id);
    dot += `  "${id}" [label="${info.name}\\n${shortId}"];\n`;
  }
  dot += "\n";

  // Add edges
  for (const [id, info] of connections) {
    for (const targetId of info.readingFrom) {
      dot += `  "${targetId}" -> "${id}";\n`;
    }
  }

  dot += "}";
  return dot;
}

export enum MapFormat {
  ASCII = "ascii",
  DOT = "dot",
}

export function formatSpaceMap(
  connections: CharmConnectionMap,
  format: MapFormat,
): string {
  switch (format) {
    case MapFormat.ASCII:
      return generateAsciiMap(connections);
    case MapFormat.DOT:
      return generateDotMap(connections);
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

export async function generateSpaceMap(
  config: SpaceConfig,
  format: MapFormat = MapFormat.ASCII,
): Promise<string> {
  const connections = await buildConnectionMap(config);
  return formatSpaceMap(connections, format);
}

export async function inspectCharm(
  config: CharmConfig,
): Promise<{
  id: string;
  name?: string;
  recipeName?: string;
  source: Readonly<unknown>;
  result: Readonly<unknown>;
  readingFrom: Array<{ id: string; name?: string }>;
  readBy: Array<{ id: string; name?: string }>;
}> {
  const manager = await loadManager(config);
  const charms = new CharmsController(manager);
  const charm = await charms.get(config.charm, false);

  const id = charm.id;
  const name = charm.name();
  const recipeName = (await charm.getRecipeMeta()).recipeName;
  const source = await charm.input.get() as Readonly<unknown>;
  const result = await charm.result.get() as Readonly<unknown>;
  const readingFrom = (await charm.readingFrom()).map((charm) => ({
    id: charm.id,
    name: charm.name(),
  }));
  const readBy = (await charm.readBy()).map((charm) => ({
    id: charm.id,
    name: charm.name(),
  }));

  return {
    id,
    name,
    recipeName,
    source,
    result,
    readingFrom,
    readBy,
  };
}

export async function getCharmView(
  config: CharmConfig,
): Promise<unknown> {
  const data = await inspectCharm(config) as any;
  return data.result?.[UI] as VNode;
}

export function formatViewTree(view: unknown): string {
  const format = (
    node: unknown,
    prefix: string,
    last: boolean,
  ): string => {
    const branch = last ? "└─ " : "├─ ";
    if (!isVNodeLike(node)) {
      return `${prefix}${branch}${String(node)}`;
    }

    const children = Array.isArray(node.children) ? node.children : [];
    let output = `${prefix}${branch}${node.name}`;
    const nextPrefix = prefix + (last ? "   " : "│  ");
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isLast = i === children.length - 1;
      output += "\n" + format(child, nextPrefix, isLast);
    }
    return output;
  };

  return format(view, "", true);
}

export async function getCellValue(
  config: CharmConfig,
  path: (string | number)[],
  options?: { input?: boolean },
): Promise<unknown> {
  const manager = await loadManager(config);
  const charms = new CharmsController(manager);
  const charm = await charms.get(config.charm, false);
  if (options?.input) {
    return await charm.input.get(path);
  } else {
    return await charm.result.get(path);
  }
}

export async function setCellValue(
  config: CharmConfig,
  path: (string | number)[],
  value: unknown,
  options?: { input?: boolean },
): Promise<void> {
  const manager = await loadManager(config);
  const charms = new CharmsController(manager);
  const charm = await charms.get(config.charm, false);
  if (options?.input) {
    await charm.input.set(value, path);
  } else {
    await charm.result.set(value, path);
  }
}

/**
 * Calls a handler within a charm by sending an event to its stream.
 */
export async function callCharmHandler<T = any>(
  config: CharmConfig,
  handlerName: string,
  args: T,
): Promise<void> {
  const manager = await loadManager(config);
  const charms = new CharmsController(manager);

  // Ensure default pattern exists (best effort)
  try {
    await charms.ensureDefaultPattern();
  } catch (error) {
    // Non-fatal, log and continue
    console.warn(
      `Warning: Could not ensure default pattern: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const charm = await charms.get(config.charm, true);

  // Get the cell and traverse to the handler using .key()
  const cell = charm.getCell().asSchema({
    type: "object",
    properties: {
      [handlerName]: { asStream: true },
    },
    required: [handlerName],
  });

  // Manual cast because typescript can't infer this automatically
  const handlerStream = cell.key(handlerName) as unknown as Stream<T>;

  // The handlerStream should be the actual stream object
  if (!isStream<T>(handlerStream)) {
    throw new Error(`Handler "${handlerName}" not found or not a stream`);
  }

  // Send the event to trigger the handler
  // Type assertion needed because TypeScript can't verify the conditional type at this generic callsite
  (handlerStream.send as (event: T) => void)(args);

  // Wait for processing to complete
  await manager.runtime.idle();
  await manager.synced();
}

/**
 * Removes a charm from the space.
 */
export async function removeCharm(
  config: CharmConfig,
): Promise<void> {
  const manager = await loadManager(config);
  const charms = new CharmsController(manager);
  const removed = await charms.remove(config.charm);

  if (!removed) {
    throw new Error(`Charm "${config.charm}" not found`);
  }
}

function isVNodeLike(value: unknown): value is VNode {
  const visited = new Set<object>();
  while (isObject(value) && UI in value) {
    if (visited.has(value)) return false; // Cycle detected
    visited.add(value);
    value = value[UI];
  }
  return (value as VNode)?.type === "vnode";
}
