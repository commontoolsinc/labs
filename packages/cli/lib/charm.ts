import { ANYONE, Identity, Session } from "@commontools/identity";
import { ensureDir } from "@std/fs";
import { loadIdentity } from "./identity.ts";
import {
  Cell,
  isStream,
  Runtime,
  RuntimeProgram,
  UI,
} from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache";
import { charmId, CharmManager, extractUserCode } from "@commontools/charm";
import { CharmsController } from "@commontools/charm/ops";
import { join } from "@std/path";
import { isVNode, type VNode } from "@commontools/html";
import { FileSystemProgramResolver } from "@commontools/js-runtime";

export interface EntryConfig {
  mainPath: string;
  mainExport?: string;
}

export interface SpaceConfig {
  apiUrl: string;
  space: string;
  identity: string;
}

export interface CharmConfig extends SpaceConfig {
  charm: string;
}

function parseSpace(
  space: string,
): string {
  if (space.startsWith("did:key:")) {
    // Need to be able to resolve a did key to a name, based
    // on current Session requirements.
    throw new Error("`space` as a DID key is not yet supported.");
  }
  if (space.startsWith("~")) {
    // Need to be able to resolve a private space to a did key, based
    // on current Session requirements.
    throw new Error("`space` must not be a private space.");
  }
  return space;
}

function getCharmIdSafe(charm: Cell<unknown>): string {
  const id = charmId(charm);
  if (!id) {
    throw new Error("Could not get an ID from a Cell<Charm>");
  }
  return id;
}

async function makeSession(config: SpaceConfig): Promise<Session> {
  if (config.space.startsWith("did:key")) {
    throw new Error("DID key spaces not yet supported.");
  }
  const root = await loadIdentity(config.identity);
  const account = config.space.startsWith("~")
    ? root
    : await Identity.fromPassphrase(ANYONE);
  const user = await account.derive(config.space);
  return {
    private: account.did() === root.did(),
    name: config.space,
    space: user.did(),
    as: user,
  };
}

export async function loadManager(config: SpaceConfig): Promise<CharmManager> {
  const session = await makeSession(config);
  // Use a const ref object so we can assign later while keeping const binding
  const charmManagerRef: { current?: CharmManager } = {};
  const runtime = new Runtime({
    storageManager: StorageManager.open({
      as: session.as,
      address: new URL("/api/storage/memory", config.apiUrl),
    }),
    blobbyServerUrl: config.apiUrl,
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
            const list = mgr.getCharms().get();
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
  const charmManager = new CharmManager(session, runtime);
  charmManagerRef.current = charmManager;
  await charmManager.synced();
  return charmManager;
}

async function getProgramFromFile(
  manager: CharmManager,
  entry: EntryConfig,
): Promise<RuntimeProgram> {
  // Walk entry file and collect all sources from fs.
  const program: RuntimeProgram = await manager.runtime.harness.resolve(
    new FileSystemProgramResolver(entry.mainPath),
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
  return Promise.all(
    charms.getAllCharms().map(async (charm) => {
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
  const program = await getProgramFromFile(manager, entry);
  const charm = await charms.create(program, options);
  return charm.id;
}

export async function setCharmRecipe(
  config: CharmConfig,
  entry: EntryConfig,
): Promise<void> {
  const manager = await loadManager(config);
  const charms = new CharmsController(manager);
  const charm = await charms.get(config.charm);
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
  const charm = await charms.get(config.charm);
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
      await Deno.writeTextFile(join(outPath, name.substring(1)), contents);
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
  const charm = await charms.get(config.charm);
  await charm.setInput(input);
}

export async function linkCharms(
  config: SpaceConfig,
  sourceCharmId: string,
  sourcePath: (string | number)[],
  targetCharmId: string,
  targetPath: (string | number)[],
): Promise<void> {
  const manager = await loadManager(config);
  await manager.link(sourceCharmId, sourcePath, targetCharmId, targetPath);
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
  const charm = await charms.get(config.charm);

  const id = charm.id;
  const name = charm.name();
  const recipeName = (await charm.getRecipeMeta()).recipeName;
  const source = charm.input.get() as Readonly<unknown>;
  const result = charm.result.get() as Readonly<unknown>;
  const readingFrom = charm.readingFrom().map((charm) => ({
    id: charm.id,
    name: charm.name(),
  }));
  const readBy = charm.readBy().map((charm) => ({
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
    if (!isVNode(node)) {
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
  const charm = await charms.get(config.charm);
  if (options?.input) {
    return charm.input.get(path);
  } else {
    return charm.result.get(path);
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
  const charm = await charms.get(config.charm);
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
  const charm = await charms.get(config.charm);

  // Get the cell and traverse to the handler using .key()
  const cell = charm.getCell().asSchema({
    type: "object",
    properties: {
      [handlerName]: { asStream: true },
    },
    required: [handlerName],
  });
  const handlerStream = cell.key(handlerName);

  // The handlerStream should be the actual stream object
  if (!isStream<T>(handlerStream)) {
    throw new Error(`Handler "${handlerName}" not found or not a stream`);
  }

  // Send the event to trigger the handler
  handlerStream.send(args);

  // Wait for processing to complete
  await manager.runtime.idle();
  await manager.synced();
}

/**
 * Removes a charm from the space (moves it to trash).
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
