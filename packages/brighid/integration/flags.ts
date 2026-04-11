const truthy = new Set(["1", "true", "yes"]);

function readFlag(...names: string[]): boolean {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim().toLowerCase();
    if (value && truthy.has(value)) {
      return true;
    }
  }
  return false;
}

export const TEST_BRIGHID_CFC_SANDBOX = readFlag(
  "TEST_BRIGHID_CFC_SANDBOX",
  "TEST_BRIGHID_REAL",
);

export const TEST_BRIGHID_RUNSC_DIRECT = readFlag(
  "TEST_BRIGHID_RUNSC_DIRECT",
  "TEST_BRIGHID_REAL",
);

export const TEST_BRIGHID_DOCKER_CFC = readFlag(
  "TEST_BRIGHID_DOCKER_CFC",
  "TEST_BRIGHID_REAL",
);
