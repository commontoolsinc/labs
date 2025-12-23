import { CharmController, CharmsController } from "@commontools/charm/ops";
import { HttpProgramResolver } from "@commontools/js-compiler";
import { API_URL } from "./env.ts";
import { type NameSchema } from "@commontools/runner/schemas";

export type BuiltinPatternType = "home" | "space-root";

type BuiltinPatternConfig = {
  url: URL;
  cause: string;
  name: string;
};

const Configs: Record<BuiltinPatternType, BuiltinPatternConfig> = {
  "home": {
    name: "Home",
    url: new URL(`/api/patterns/system/home.tsx`, API_URL),
    cause: "home-pattern",
  },
  "space-root": {
    name: "DefaultCharmList",
    url: new URL(`/api/patterns/system/default-app.tsx`, API_URL),
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
