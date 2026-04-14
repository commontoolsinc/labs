type DockerDaemonConfig = {
  runtimes?: Record<string, {
    path?: string;
    runtimeArgs?: string[];
  }>;
  [key: string]: unknown;
};

const DEFAULT_RUNTIME = "runsc-cfc";
const DEFAULT_LOCAL_DIR = ".local/share/runsc-cfc";
const DEFAULT_RUNSC_RELATIVE = "bazel-bin/runsc/runsc_/runsc";
const DEFAULT_POLICY_RELATIVE = "demo/cfc-policy.json";

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function decodeUrlPath(url: URL): string {
  return decodeURIComponent(url.pathname);
}

function joinPath(...parts: string[]): string {
  return parts
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function ensureRegularNonSymlinkFile(
  path: string,
  description: string,
): Promise<string> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`${description} not found: ${path}`);
    }
    throw error;
  }

  if (info.isSymlink) {
    throw new Error(`${description} must not be a symlink: ${path}`);
  }
  if (!info.isFile) {
    throw new Error(`${description} must be a regular file: ${path}`);
  }

  return await Deno.realPath(path);
}

async function ensureSafeExecutableFile(
  path: string,
  description: string,
): Promise<string> {
  const realPath = await ensureRegularNonSymlinkFile(path, description);
  const info = await Deno.stat(realPath);
  if ((info.mode ?? 0) & 0o022) {
    throw new Error(
      `${description} must not be group/world writable: ${realPath}`,
    );
  }
  return realPath;
}

async function ensureSafeDataFile(
  path: string,
  description: string,
): Promise<string> {
  const realPath = await ensureRegularNonSymlinkFile(path, description);
  const info = await Deno.stat(realPath);
  if ((info.mode ?? 0) & 0o022) {
    throw new Error(
      `${description} must not be group/world writable: ${realPath}`,
    );
  }
  return realPath;
}

function dirname(path: string): string {
  const normalized = path.replace(/\/+/g, "/").replace(/\/$/, "");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

async function discoverGvisorCheckout(
  repoRoot: string,
): Promise<string | null> {
  const explicit = envValue(
    "BRIGHID_GVISOR_CHECKOUT",
    "CFC_SHELL_GVISOR_CHECKOUT",
  );
  if (explicit) {
    return explicit;
  }

  const parent = dirname(repoRoot);
  const candidates: Array<
    { path: string; runscPath: string; policyPath: string; mtime: number }
  > = [];
  for await (const entry of Deno.readDir(parent)) {
    if (!entry.isDirectory || !entry.name.startsWith("gvisor")) continue;
    const candidate = joinPath(parent, entry.name);
    const runscPath = joinPath(candidate, DEFAULT_RUNSC_RELATIVE);
    const policyPath = joinPath(candidate, DEFAULT_POLICY_RELATIVE);
    if (!await pathExists(runscPath) || !await pathExists(policyPath)) {
      continue;
    }
    const info = await Deno.stat(runscPath);
    candidates.push({
      path: candidate,
      runscPath,
      policyPath,
      mtime: info.mtime?.getTime() ?? 0,
    });
  }

  candidates.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  if (candidates.length > 0) {
    return candidates[0].path;
  }

  return null;
}

async function readDaemonConfig(path: string): Promise<DockerDaemonConfig> {
  if (!await pathExists(path)) {
    return {};
  }
  const text = await Deno.readTextFile(path);
  return JSON.parse(text) as DockerDaemonConfig;
}

async function runCommand(
  command: string,
  args: string[],
  description: string,
): Promise<string> {
  const result = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (result.code !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    const stdout = new TextDecoder().decode(result.stdout).trim();
    throw new Error(
      `${description} failed: ${stderr || stdout || `exit ${result.code}`}`,
    );
  }

  return new TextDecoder().decode(result.stdout).trim();
}

async function waitForDocker(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await runCommand("docker", ["info"], "docker info");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error("Timed out waiting for Docker Desktop after restart");
}

function hostMntPath(hostPath: string): string {
  if (!hostPath.startsWith("/Users/")) {
    throw new Error(
      `Expected a host path under /Users for Docker Desktop /host_mnt mapping: ${hostPath}`,
    );
  }
  return `/host_mnt${hostPath}`;
}

async function main(): Promise<void> {
  const packageDir = decodeUrlPath(new URL("..", import.meta.url));
  const repoRoot = decodeUrlPath(new URL("../../../", import.meta.url));
  const home = Deno.env.get("HOME");
  if (!home) {
    throw new Error("HOME is not set");
  }

  const runtimeAlias =
    envValue("BRIGHID_DOCKER_RUNTIME", "CFC_SHELL_DOCKER_RUNTIME") ??
      DEFAULT_RUNTIME;
  const localDir = envValue("BRIGHID_DOCKER_DESKTOP_LOCAL_DIR") ??
    joinPath(home, DEFAULT_LOCAL_DIR);
  const daemonConfigPath = envValue("BRIGHID_DOCKER_DESKTOP_DAEMON_CONFIG") ??
    joinPath(home, ".docker/daemon.json");
  const restartDesktop = envValue("BRIGHID_DOCKER_DESKTOP_RESTART") !== "0";
  const smokeImage = envValue("BRIGHID_DOCKER_DESKTOP_SMOKE_IMAGE") ??
    "alpine:3.20";
  const allowAliasOverwrite =
    envValue("BRIGHID_DOCKER_DESKTOP_OVERWRITE_RUNTIME") === "1";

  const gvisorCheckout = await discoverGvisorCheckout(repoRoot);
  if (!gvisorCheckout) {
    throw new Error(
      `Could not find a sibling gVisor checkout next to ${repoRoot}. Set BRIGHID_GVISOR_CHECKOUT explicitly.`,
    );
  }

  const runscSource = envValue("BRIGHID_DOCKER_DESKTOP_RUNSC_SRC") ??
    joinPath(gvisorCheckout, DEFAULT_RUNSC_RELATIVE);
  const policySource = envValue("BRIGHID_DOCKER_DESKTOP_POLICY_SRC") ??
    joinPath(gvisorCheckout, DEFAULT_POLICY_RELATIVE);

  const safeRunscSource = await ensureSafeExecutableFile(
    runscSource,
    "runsc binary",
  );
  const safePolicySource = await ensureSafeDataFile(
    policySource,
    "CFC policy file",
  );

  await Deno.mkdir(localDir, { recursive: true });

  const runscDest = joinPath(localDir, "runsc");
  const policyDest = joinPath(localDir, "cfc-policy.json");
  await Deno.copyFile(safeRunscSource, runscDest);
  await Deno.copyFile(safePolicySource, policyDest);
  await Deno.chmod(runscDest, 0o755);
  await Deno.chmod(policyDest, 0o644);
  await ensureSafeExecutableFile(runscDest, "installed runsc binary");
  await ensureSafeDataFile(policyDest, "installed CFC policy file");

  const daemonConfig = await readDaemonConfig(daemonConfigPath);
  const backupPath = `${daemonConfigPath}.backup.${Date.now()}`;
  if (await pathExists(daemonConfigPath)) {
    await Deno.copyFile(daemonConfigPath, backupPath);
  }

  const runtimeConfig = {
    path: hostMntPath(runscDest),
    runtimeArgs: [
      "--cfc",
      `--cfc-policy=${hostMntPath(policyDest)}`,
    ],
  };

  const existingRuntime = daemonConfig.runtimes?.[runtimeAlias];
  if (
    existingRuntime &&
    (existingRuntime.path !== runtimeConfig.path ||
      JSON.stringify(existingRuntime.runtimeArgs ?? []) !==
        JSON.stringify(runtimeConfig.runtimeArgs)) &&
    !allowAliasOverwrite
  ) {
    throw new Error(
      `Docker runtime '${runtimeAlias}' already exists with different settings. ` +
        `Set BRIGHID_DOCKER_DESKTOP_OVERWRITE_RUNTIME=1 to replace it.`,
    );
  }

  const nextConfig: DockerDaemonConfig = {
    ...daemonConfig,
    runtimes: {
      ...(daemonConfig.runtimes ?? {}),
      [runtimeAlias]: runtimeConfig,
    },
  };

  await Deno.mkdir(dirname(daemonConfigPath), { recursive: true });
  await Deno.writeTextFile(
    `${daemonConfigPath}.tmp`,
    JSON.stringify(nextConfig, null, 2) + "\n",
  );
  await Deno.rename(`${daemonConfigPath}.tmp`, daemonConfigPath);

  console.log(
    `Configured Docker runtime '${runtimeAlias}' in ${daemonConfigPath}`,
  );
  console.log(`Backed up previous daemon config to ${backupPath}`);
  console.log(`runsc source: ${safeRunscSource}`);
  console.log(`policy source: ${safePolicySource}`);
  console.log(`runsc host path: ${runscDest}`);
  console.log(`policy host path: ${policyDest}`);
  console.log(`runsc daemon path: ${runtimeConfig.path}`);

  if (restartDesktop) {
    console.log("Restarting Docker Desktop...");
    await runCommand(
      "docker",
      ["desktop", "restart"],
      "docker desktop restart",
    );
    await waitForDocker();
  } else {
    console.log(
      "Skipping Docker Desktop restart because BRIGHID_DOCKER_DESKTOP_RESTART=0",
    );
  }

  const runtimes = JSON.parse(
    await runCommand(
      "docker",
      ["info", "--format", "{{json .Runtimes}}"],
      "docker info runtimes",
    ),
  ) as Record<string, { path?: string }>;
  if (!Object.hasOwn(runtimes, runtimeAlias)) {
    throw new Error(
      `Docker runtime ${runtimeAlias} is not configured after setup`,
    );
  }

  console.log(
    `Docker reports runtime '${runtimeAlias}' at ${
      runtimes[runtimeAlias]?.path ?? "(unknown path)"
    }`,
  );

  const writtenConfig = await readDaemonConfig(daemonConfigPath);
  const writtenRuntime = writtenConfig.runtimes?.[runtimeAlias];
  if (
    !writtenRuntime ||
    writtenRuntime.path !== runtimeConfig.path ||
    JSON.stringify(writtenRuntime.runtimeArgs ?? []) !==
      JSON.stringify(runtimeConfig.runtimeArgs)
  ) {
    throw new Error(
      `daemon.json runtime '${runtimeAlias}' does not match the expected Docker Desktop config`,
    );
  }

  const smokeOutput = await runCommand(
    "docker",
    [
      "run",
      "--rm",
      "--runtime",
      runtimeAlias,
      smokeImage,
      "/bin/echo",
      "brighid-docker-cfc-ok",
    ],
    "docker runtime smoke test",
  );
  if (!smokeOutput.includes("brighid-docker-cfc-ok")) {
    throw new Error(`Unexpected smoke test output: ${smokeOutput}`);
  }

  console.log("Smoke test passed.");
  console.log("");
  console.log("Use the Docker-backed runtime with Brighid's real shell path:");
  console.log(`  cd ${packageDir}`);
  console.log(
    `  BRIGHID_SANDBOX_RUNTIME=docker-cfc BRIGHID_DOCKER_RUNTIME=${runtimeAlias} deno task brighid`,
  );
  console.log(
    "  # then inside Brighid, plain shell-like commands use the real sandbox, e.g. ls / or cat /etc/os-release",
  );
  console.log(
    "  # note: current-shell state commands like cd/export/read/source remain supervisor-side, and sandboxed bash has network enabled by default unless disabled",
  );
  console.log(
    `  TEST_BRIGHID_DOCKER_CFC=1 BRIGHID_SANDBOX_RUNTIME=docker-cfc BRIGHID_DOCKER_RUNTIME=${runtimeAlias} deno task integration:docker`,
  );
}

if (import.meta.main) {
  await main();
}
