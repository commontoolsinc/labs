import { CharmController, CharmsController } from "@commontools/charm/ops";
import { HttpProgramResolver } from "@commontools/js-compiler";
import { API_URL } from "./env.ts";

export type BuiltinPatternType = "home" | "space-default";

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
  "space-default": {
    name: "DefaultCharmList",
    url: new URL(`/api/patterns/default-app.tsx`, API_URL),
    cause: "default-charm",
  },
};

export async function create(
  cc: CharmsController,
  type: BuiltinPatternType,
): Promise<CharmController> {
  const config = Configs[type];
  const manager = cc.manager();
  const runtime = manager.runtime;

  const program = await cc.manager().runtime.harness.resolve(
    new HttpProgramResolver(config.url.href),
  );

  const charm = await cc.create(program, undefined, config.cause);

  // Wait for the link to be processed
  await runtime.idle();
  await manager.synced();

  if (type === "space-default") {
    // Link the default pattern to the space cell
    await manager.linkDefaultPattern(charm.getCell());
  }

  return charm;
}

export function getPattern(
  charms: CharmController[],
  type: BuiltinPatternType,
): CharmController | undefined {
  const config = Configs[type];
  return charms.find((c) => {
    const name = c.name();
    return name && name.startsWith(config.name);
  });
}
