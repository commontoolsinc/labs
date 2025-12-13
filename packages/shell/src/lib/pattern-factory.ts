import { CharmController, CharmsController } from "@commontools/charm/ops";
import { HttpProgramResolver } from "@commontools/js-compiler";
import { API_URL } from "./env.ts";
import { NameSchema } from "@commontools/charm";
import { RuntimeWorker } from "@commontools/runner/worker";
import { CharmHandle } from "./runtime.ts";

export type BuiltinPatternType = "home" | "space-root";

type BuiltinPatternConfig = {
  url: URL;
  cause: string;
  name: string;
};

const Configs: Record<BuiltinPatternType, BuiltinPatternConfig> = {
  "home": {
    name: "Home",
    url: new URL(`/api/patterns/home.tsx`, API_URL),
    cause: "home-pattern",
  },
  "space-root": {
    name: "DefaultCharmList",
    url: new URL(`/api/patterns/default-app.tsx`, API_URL),
    cause: "space-root",
  },
};

export async function create(
  cc: CharmsController,
  type: BuiltinPatternType,
): Promise<CharmController<NameSchema>> {
  const config = Configs[type];
  const manager = cc.manager();
  const runtime = manager.runtime;

  const program = await cc.manager().runtime.harness.resolve(
    new HttpProgramResolver(config.url.href),
  );

  const charm = await cc.create<NameSchema>(
    program,
    { start: true },
    config.cause,
  );

  // Wait for the link to be processed
  await runtime.idle();
  await manager.synced();

  // Link the default pattern to the space cell
  await manager.linkDefaultPattern(charm.getCell());

  return charm;
}

export async function get(
  cc: CharmsController,
): Promise<CharmController<NameSchema> | undefined> {
  const pattern = await cc.manager().getDefaultPattern();
  if (!pattern) {
    return undefined;
  }
  return new CharmController(cc.manager(), pattern);
}

export async function getOrCreate(
  cc: CharmsController,
  type: BuiltinPatternType,
): Promise<CharmController<NameSchema>> {
  const pattern = await get(cc);
  if (pattern) {
    return pattern;
  }
  return await create(cc, type);
}

// ============================================================================
// RuntimeWorker-compatible versions
// ============================================================================

/**
 * Create a pattern using RuntimeWorker.
 * Uses the pattern URL directly - the worker will resolve and compile it.
 */
export async function createWorker(
  worker: RuntimeWorker,
  type: BuiltinPatternType,
): Promise<CharmHandle<NameSchema>> {
  const config = Configs[type];

  // Pass the URL directly - CharmsController.create in the worker
  // can handle URL strings and will resolve them
  const result = await worker.createCharmFromUrl<NameSchema>(config.url, {
    run: true,
  });

  // Wait for operations to complete
  await worker.idle();
  await worker.synced();

  // Note: linkDefaultPattern is handled internally by CharmManager
  // when creating charms with specific causes

  return new CharmHandle(result.id, result.cell);
}

/**
 * Get or create a pattern using RuntimeWorker.
 * For now, always creates since we don't have getDefaultPattern via IPC.
 * TODO: Add getDefaultPattern IPC to avoid recreating patterns.
 */
export async function getOrCreateWorker(
  worker: RuntimeWorker,
  type: BuiltinPatternType,
): Promise<CharmHandle<NameSchema>> {
  // TODO: Check if pattern already exists via getDefaultPattern IPC
  // For now, just create it - the worker's CharmManager will handle dedup
  return await createWorker(worker, type);
}
