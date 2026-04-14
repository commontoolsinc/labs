/**
 * Sandboxed Executor
 *
 * Executes real commands in a sandboxed subprocess with label tracking.
 * Inputs are labeled; outputs get conservative labels based on all inputs.
 *
 * Key principle: Real execution is a black box. Output labels are conservative:
 * - Confidentiality: join of all inputs (output might contain any input)
 * - Integrity: intersection of inputs + SandboxedExec atom (reduced trust)
 */

import { Label, Labeled, labels } from "../labels.ts";
import { VFS } from "../vfs.ts";
import { defaultConfig, mergeConfig, SandboxedExecConfig } from "./config.ts";
import { exportToReal, importFromReal } from "./vfs-bridge.ts";

/** Check for permission/capability errors across Deno versions */
function isPermissionError(e: unknown): boolean {
  return e instanceof Deno.errors.PermissionDenied ||
    ((Deno.errors as any).NotCapable != null &&
      e instanceof (Deno.errors as any).NotCapable);
}

export interface SandboxResult {
  stdout: Labeled<string>;
  stderr: Labeled<string>;
  exitCode: number;
  modifiedFiles: Map<string, Labeled<Uint8Array>>;
}

export interface SandboxExecutionOptions {
  cwd?: string;
  mirrorRootIntoGuest?: boolean;
}

interface PersistentRunscSession {
  tempDir: string;
  bundleDir: string;
  containerId: string;
  runscRoot: string;
  mountedRoots: string[];
  fabricMount: {
    hostPath: string;
    cleanup: () => Promise<void>;
  } | null;
}

const GVISOR_REPO_ROOT = new URL("../../../../../gvisor/", import.meta.url);
const LABS_REPO_ROOT = new URL("../../../../", import.meta.url);
const DEFAULT_CFC_SANDBOX_BIN = new URL(
  "tools/cfc-sandbox/.build/release/cfc-sandbox",
  GVISOR_REPO_ROOT,
);
const DEFAULT_RUNSC_BIN = new URL(
  "bazel-bin/runsc/runsc_/runsc",
  GVISOR_REPO_ROOT,
);
const DEFAULT_POLICY_PATH = new URL(
  "tools/cfc-sandbox-image/cfc-policy.json",
  GVISOR_REPO_ROOT,
);
const DEFAULT_LABS_CHECKOUT = new URL(".", LABS_REPO_ROOT);

function toLocalPath(url: URL): string {
  return decodeURIComponent(url.pathname);
}

async function pathExists(path: string | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch {
    return false;
  }
}

async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function envOverride(...names: string[]): string | undefined {
  try {
    for (const name of names) {
      const value = Deno.env.get(name);
      if (value != null && value !== "") {
        return value;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function getProcessIds(): { uid: number; gid: number } {
  try {
    const uid = typeof Deno.uid === "function" ? Deno.uid() : null;
    const gid = typeof Deno.gid === "function" ? Deno.gid() : null;
    return {
      uid: uid ?? 0,
      gid: gid ?? 0,
    };
  } catch {
    return { uid: 0, gid: 0 };
  }
}

export class SandboxedExecutor {
  private runscSession: PersistentRunscSession | null = null;

  constructor(private config: SandboxedExecConfig = defaultConfig) {}

  /**
   * Execute a real command in a sandboxed subprocess.
   *
   * This uses Deno.Command (or a shim for environments without it).
   * Input data labels are tracked; output gets conservative labels.
   *
   * @param command - the command to run (e.g., "python", "node")
   * @param args - command arguments
   * @param stdin - labeled stdin data
   * @param inputLabels - labels of all data flowing into this execution
   * @param vfs - the VFS (for exporting files to sandbox)
   * @param exportPaths - VFS paths to make available in sandbox
   */
  async execute(
    command: string,
    args: string[],
    stdin: Labeled<string> | null,
    inputLabels: Label[],
    vfs: VFS,
    exportPaths: string[],
    options: SandboxExecutionOptions = {},
  ): Promise<SandboxResult> {
    const hasDenoCommand = typeof Deno !== "undefined" &&
      typeof Deno.Command === "function";

    if (!hasDenoCommand) {
      // Stub mode: return a result indicating sandbox is not available
      return this.executeStub(command, args, stdin, inputLabels);
    }

    const runtime = await this.resolveSandboxRuntime();

    let tempDir: string;
    let shouldCleanupTempDir = true;
    try {
      if (runtime === "runsc-direct" && this.runscSession) {
        tempDir = this.runscSession.tempDir;
        shouldCleanupTempDir = false;
      } else {
        tempDir = await Deno.makeTempDir({ prefix: "cfc-sandbox-" });
      }
    } catch (e: unknown) {
      if (isPermissionError(e)) {
        return this.executeStub(command, args, stdin, inputLabels);
      }
      throw e;
    }

    try {
      const exportedLabels = await exportToReal(vfs, exportPaths, tempDir);
      const allInputLabels: Label[] = [...inputLabels];
      if (stdin) {
        allInputLabels.push(stdin.label);
      }
      for (const label of exportedLabels.values()) {
        allInputLabels.push(label);
      }

      const outputLabel = this.computeOutputLabel(allInputLabels);
      const env: Record<string, string> = {
        ...this.config.env,
        CFC_SANDBOX: "true",
        CFC_SANDBOX_ROOT: tempDir,
      };
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, this.config.timeout);

      try {
        const result = runtime === "cfc-sandbox"
          ? await this.executeWithCfcSandbox(
            command,
            args,
            stdin,
            outputLabel,
            tempDir,
            env,
            abortController.signal,
            options,
          )
          : runtime === "docker-cfc"
          ? await this.executeWithDockerCfc(
            command,
            args,
            stdin,
            outputLabel,
            tempDir,
            env,
            abortController.signal,
            options,
          )
          : runtime === "runsc-direct"
          ? await this.executeWithRunscDirect(
            command,
            args,
            stdin,
            outputLabel,
            tempDir,
            env,
            abortController.signal,
            options,
          )
          : await this.executeWithHostProcess(
            command,
            args,
            stdin,
            outputLabel,
            tempDir,
            env,
            abortController.signal,
          );

        clearTimeout(timeoutId);

        const modifiedFiles = await this.importWritableChanges(
          vfs,
          tempDir,
          outputLabel,
          options,
        );

        return {
          stdout: { value: result.stdout, label: outputLabel },
          stderr: { value: result.stderr, label: outputLabel },
          exitCode: result.exitCode,
          modifiedFiles,
        };
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error && error.name === "AbortError") {
          return {
            stdout: {
              value: "",
              label: outputLabel,
            },
            stderr: {
              value:
                `[BRIGHID] Command timed out after ${this.config.timeout}ms`,
              label: outputLabel,
            },
            exitCode: 124,
            modifiedFiles: new Map(),
          };
        }

        throw error;
      }
    } finally {
      if (shouldCleanupTempDir) {
        try {
          await Deno.remove(tempDir, { recursive: true });
        } catch (error) {
          console.error(
            `Failed to clean up temp directory ${tempDir}: ${error}`,
          );
        }
      }
    }
  }

  private async resolveSandboxRuntime(): Promise<
    "host" | "cfc-sandbox" | "docker-cfc" | "runsc-direct"
  > {
    const hostOs = this.getHostOs();
    const runtimeOverride = envOverride(
      "BRIGHID_SANDBOX_RUNTIME",
      "CFC_SHELL_SANDBOX_RUNTIME",
    );
    if (
      runtimeOverride === "host" || runtimeOverride === "cfc-sandbox" ||
      runtimeOverride === "docker-cfc" || runtimeOverride === "runsc-direct"
    ) {
      return runtimeOverride;
    }

    if (this.config.backend === "host") {
      return "host";
    }
    if (this.config.sandboxRuntime === "cfc-sandbox") {
      return "cfc-sandbox";
    }
    if (this.config.sandboxRuntime === "docker-cfc") {
      return "docker-cfc";
    }
    if (this.config.sandboxRuntime === "runsc-direct") {
      return "runsc-direct";
    }

    if (hostOs === "darwin" && await this.cfcSandboxAvailable()) {
      return "cfc-sandbox";
    }

    if ((hostOs === "darwin" || hostOs === "linux") &&
      await this.dockerRuntimeAvailable()) {
      return "docker-cfc";
    }

    if (hostOs === "linux" && await this.runscDirectAvailable()) {
      return "runsc-direct";
    }

    return "host";
  }

  protected getHostOs(): typeof Deno.build.os {
    return Deno.build.os;
  }

  protected async cfcSandboxAvailable(): Promise<boolean> {
    return await pathExists(this.resolveCfcSandboxBinary()) &&
      await pathExists(this.resolveRunscBinary());
  }

  private resolveCfcSandboxBinary(): string {
    return envOverride(
      "BRIGHID_CFC_SANDBOX_BIN",
      "CFC_SHELL_CFC_SANDBOX_BIN",
    ) ??
      this.config.cfcSandboxBinary ??
      toLocalPath(DEFAULT_CFC_SANDBOX_BIN);
  }

  private resolveDockerBinary(): string {
    return envOverride("BRIGHID_DOCKER_BIN", "CFC_SHELL_DOCKER_BIN") ??
      this.config.dockerBinaryPath ??
      "docker";
  }

  private resolveDockerRuntimeName(): string {
    return envOverride("BRIGHID_DOCKER_RUNTIME", "CFC_SHELL_DOCKER_RUNTIME") ??
      this.config.dockerRuntimeName ??
      "runsc-cfc";
  }

  protected async dockerRuntimeAvailable(): Promise<boolean> {
    try {
      const output = await new Deno.Command(this.resolveDockerBinary(), {
        args: ["info", "--format", "{{json .Runtimes}}"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (output.code !== 0) {
        return false;
      }
      const runtimes = JSON.parse(
        new TextDecoder().decode(output.stdout),
      ) as Record<
        string,
        unknown
      >;
      return Object.hasOwn(runtimes, this.resolveDockerRuntimeName());
    } catch {
      return false;
    }
  }

  protected async runscDirectAvailable(): Promise<boolean> {
    return await pathExists(this.resolveRunscBinary()) &&
      await pathExists(this.resolveRunscRootfsPath());
  }

  private resolveRunscBinary(): string | undefined {
    return envOverride("BRIGHID_RUNSC_BIN", "CFC_SHELL_RUNSC_BIN") ??
      this.config.runscBinaryPath ??
      toLocalPath(DEFAULT_RUNSC_BIN);
  }

  private resolveRunscRootPath(): string {
    return envOverride("BRIGHID_RUNSC_ROOT", "CFC_SHELL_RUNSC_ROOT") ??
      this.config.runscRootPath ??
      `${Deno.cwd()}/.brighid/runsc-root`;
  }

  private resolveRunscRootfsPath(): string | undefined {
    return envOverride("BRIGHID_RUNSC_ROOTFS", "CFC_SHELL_RUNSC_ROOTFS") ??
      this.config.runscRootfsPath;
  }

  private resolvePolicyPath(): string | undefined {
    return envOverride(
      "BRIGHID_SANDBOX_POLICY",
      "CFC_SHELL_SANDBOX_POLICY",
    ) ??
      this.config.policyPath ??
      toLocalPath(DEFAULT_POLICY_PATH);
  }

  private resolveImage(): string {
    return envOverride("BRIGHID_SANDBOX_IMAGE", "CFC_SHELL_SANDBOX_IMAGE") ??
      this.config.image ??
      "docker.io/library/alpine:latest";
  }

  private resolveLabsCheckout(): string {
    return envOverride("BRIGHID_LABS_CHECKOUT", "CFC_SHELL_LABS_CHECKOUT") ??
      this.config.labsCheckout ??
      toLocalPath(DEFAULT_LABS_CHECKOUT);
  }

  private resolveFabricHostPath(): string | undefined {
    return envOverride(
      "BRIGHID_FABRIC_HOST_PATH",
      "CFC_SHELL_FABRIC_HOST_PATH",
    ) ??
      this.config.fabricHostPath;
  }

  private async resolveFabricMount(): Promise<
    {
      hostPath: string;
      cleanup: () => Promise<void>;
    } | null
  > {
    if (this.config.fabricMountMode === "none") {
      return null;
    }

    const existingHostPath = this.resolveFabricHostPath();
    if (existingHostPath) {
      return {
        hostPath: existingHostPath,
        cleanup: async () => {},
      };
    }

    const labsCheckout = this.resolveLabsCheckout();
    const mountpoint = await Deno.makeTempDir({ prefix: "ct-fuse-runsc-" });
    const identityFile = await Deno.makeTempFile({ prefix: "ct-fuse-id-" });

    try {
      const identityResult = await new Deno.Command("deno", {
        args: ["task", "cf", "id", "new"],
        stdout: "piped",
        stderr: "piped",
        cwd: labsCheckout,
      }).output();

      if (identityResult.code !== 0) {
        const decoder = new TextDecoder();
        throw new Error(decoder.decode(identityResult.stderr));
      }

      const identity = new TextDecoder().decode(identityResult.stdout).trim();
      await Deno.writeTextFile(identityFile, `${identity}\n`);

      const mountResult = await new Deno.Command("deno", {
        args: [
          "task",
          "cf",
          "fuse",
          "mount",
          mountpoint,
          "--api-url",
          this.config.toolshedApiUrl,
          "--identity",
          identityFile,
          "--allow-root",
          "--background",
        ],
        stdout: "piped",
        stderr: "piped",
        cwd: labsCheckout,
      }).output();

      if (mountResult.code !== 0) {
        const decoder = new TextDecoder();
        throw new Error(decoder.decode(mountResult.stderr));
      }

      const readyPath = `${mountpoint}/.spaces.json`;
      const deadline = Date.now() + this.config.fabricWaitSeconds * 1000;
      while (Date.now() < deadline) {
        if (await fileExists(readyPath)) {
          return {
            hostPath: mountpoint,
            cleanup: async () => {
              await this.unmountLabsFuse(
                labsCheckout,
                mountpoint,
                identityFile,
              );
            },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      throw new Error(`timed out waiting for ${readyPath}`);
    } catch (error) {
      await this.unmountLabsFuse(labsCheckout, mountpoint, identityFile);
      throw error;
    }
  }

  private async unmountLabsFuse(
    labsCheckout: string,
    mountpoint: string,
    identityFile: string,
  ): Promise<void> {
    try {
      await new Deno.Command("deno", {
        args: ["task", "cf", "fuse", "unmount", mountpoint],
        stdout: "null",
        stderr: "null",
        cwd: labsCheckout,
      }).output();
    } catch {
    }

    try {
      await Deno.remove(mountpoint, { recursive: true });
    } catch {
    }

    try {
      await Deno.remove(identityFile);
    } catch {
    }
  }

  private async executeWithHostProcess(
    command: string,
    args: string[],
    stdin: Labeled<string> | null,
    _outputLabel: Label,
    tempDir: string,
    env: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cmd = new Deno.Command(command, {
      args,
      stdin: stdin ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
      env,
      cwd: tempDir,
      signal,
    });

    let process;
    try {
      process = cmd.spawn();
    } catch (e: unknown) {
      if (isPermissionError(e) || e instanceof Deno.errors.NotFound) {
        const stub = this.executeStub(command, args, stdin, []);
        return {
          stdout: stub.stdout.value,
          stderr: stub.stderr.value,
          exitCode: stub.exitCode,
        };
      }
      throw e;
    }

    if (stdin && process.stdin) {
      const writer = process.stdin.getWriter();
      const encoder = new TextEncoder();
      await writer.write(encoder.encode(stdin.value));
      await writer.close();
    }

    const output = await process.output();
    const decoder = new TextDecoder();
    return {
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
      exitCode: output.code,
    };
  }

  private async executeWithCfcSandbox(
    command: string,
    args: string[],
    stdin: Labeled<string> | null,
    _outputLabel: Label,
    tempDir: string,
    env: Record<string, string>,
    signal: AbortSignal,
    options: SandboxExecutionOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const sandboxBinary = this.resolveCfcSandboxBinary();
    const runscBinary = this.resolveRunscBinary();

    if (!runscBinary) {
      throw new Error("cfc-sandbox backend requires a runsc binary");
    }

    const guestWorkspacePath = this.config.guestWorkspacePath;
    const fabricMount = await this.resolveFabricMount();

    try {
      const sandboxArgs = [
        "run",
        "--runsc-bin",
        runscBinary,
        "--image",
        this.resolveImage(),
      ];

      const policyPath = this.resolvePolicyPath();
      if (policyPath) {
        sandboxArgs.push("--policy", policyPath);
      }

      for (const [key, value] of Object.entries(env)) {
        sandboxArgs.push("-e", `${key}=${value}`);
      }

      if (this.config.allowNetwork) {
        sandboxArgs.push("-e", "CFC_SHELL_ALLOW_NETWORK=true");
      }

      if (options.mirrorRootIntoGuest) {
        for await (const entry of Deno.readDir(tempDir)) {
          if (entry.isDirectory) {
            sandboxArgs.push(
              "--mount",
              `${tempDir}/${entry.name}:/${entry.name}:rw`,
            );
          }
        }
      }

      if (fabricMount) {
        sandboxArgs.push("--allow-fabric-host-mount");
        sandboxArgs.push(
          "--mount",
          `${fabricMount.hostPath}:${this.config.fabricGuestPath}:rw`,
        );
      }

      sandboxArgs.push("--mount", `${tempDir}:${guestWorkspacePath}:rw`);
      sandboxArgs.push(command, ...args);

      const cmd = new Deno.Command(sandboxBinary, {
        args: sandboxArgs,
        stdin: stdin ? "piped" : "null",
        stdout: "piped",
        stderr: "piped",
        signal,
      });

      const process = cmd.spawn();

      if (stdin && process.stdin) {
        const writer = process.stdin.getWriter();
        const encoder = new TextEncoder();
        await writer.write(encoder.encode(stdin.value));
        await writer.close();
      }

      const output = await process.output();
      const decoder = new TextDecoder();
      return {
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
        exitCode: output.code,
      };
    } finally {
      await fabricMount?.cleanup();
    }
  }

  private async executeWithDockerCfc(
    command: string,
    args: string[],
    stdin: Labeled<string> | null,
    _outputLabel: Label,
    tempDir: string,
    env: Record<string, string>,
    signal: AbortSignal,
    options: SandboxExecutionOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const guestWorkspacePath = this.config.guestWorkspacePath;
    const guestCwd = options.cwd
      ? this.mapRunscCwd(options.cwd, guestWorkspacePath)
      : guestWorkspacePath;
    const fabricMount = await this.resolveFabricMount();

    try {
      const dockerArgs = [
        "run",
        "--runtime",
        this.resolveDockerRuntimeName(),
        "--rm",
        "--workdir",
        guestCwd,
      ];

      if (!this.config.allowNetwork) {
        dockerArgs.push("--network", "none");
      }

      for (const [key, value] of Object.entries(env)) {
        dockerArgs.push("-e", `${key}=${value}`);
      }

      if (options.mirrorRootIntoGuest) {
        for await (const entry of Deno.readDir(tempDir)) {
          if (entry.isDirectory) {
            dockerArgs.push(
              "--mount",
              `type=bind,src=${tempDir}/${entry.name},dst=/${entry.name}`,
            );
          }
        }
      }

      if (fabricMount) {
        dockerArgs.push(
          "--mount",
          `type=bind,src=${fabricMount.hostPath},dst=${this.config.fabricGuestPath}`,
        );
      }

      dockerArgs.push(
        "--mount",
        `type=bind,src=${tempDir},dst=${guestWorkspacePath}`,
      );
      dockerArgs.push(this.resolveImage(), command, ...args);

      const cmd = new Deno.Command(this.resolveDockerBinary(), {
        args: dockerArgs,
        stdin: stdin ? "piped" : "null",
        stdout: "piped",
        stderr: "piped",
        signal,
      });
      const process = cmd.spawn();

      if (stdin && process.stdin) {
        const writer = process.stdin.getWriter();
        const encoder = new TextEncoder();
        await writer.write(encoder.encode(stdin.value));
        await writer.close();
      }

      const output = await process.output();
      const decoder = new TextDecoder();
      return {
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
        exitCode: output.code,
      };
    } finally {
      await fabricMount?.cleanup();
    }
  }

  private async executeWithRunscDirect(
    command: string,
    args: string[],
    stdin: Labeled<string> | null,
    _outputLabel: Label,
    tempDir: string,
    env: Record<string, string>,
    signal: AbortSignal,
    options: SandboxExecutionOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const runscBinary = this.resolveRunscBinary();
    const rootfsPath = this.resolveRunscRootfsPath();

    if (!runscBinary) {
      throw new Error("runsc-direct runtime requires a runsc binary");
    }
    if (!rootfsPath) {
      throw new Error(
        "runsc-direct runtime requires CFC_SHELL_RUNSC_ROOTFS or config.runscRootfsPath",
      );
    }

    const session = await this.ensureRunscSession(
      runscBinary,
      rootfsPath,
      tempDir,
      options,
    );
    const execArgs = [
      ...this.baseRunscArgs(session.runscRoot),
      "exec",
      "--cwd",
      options.cwd
        ? this.mapRunscCwd(options.cwd, this.config.guestWorkspacePath)
        : this.config.guestWorkspacePath,
    ];

    for (const [key, value] of Object.entries(env)) {
      execArgs.push("--env", `${key}=${value}`);
    }

    execArgs.push(session.containerId, command, ...args);

    const cmd = new Deno.Command(runscBinary, {
      args: execArgs,
      stdin: stdin ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
      signal,
    });
    const process = cmd.spawn();

    if (stdin && process.stdin) {
      const writer = process.stdin.getWriter();
      const encoder = new TextEncoder();
      await writer.write(encoder.encode(stdin.value));
      await writer.close();
    }

    const output = await process.output();
    const decoder = new TextDecoder();
    return {
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
      exitCode: output.code,
    };
  }

  private async ensureRunscSession(
    runscBinary: string,
    rootfsPath: string,
    tempDir: string,
    options: SandboxExecutionOptions,
  ): Promise<PersistentRunscSession> {
    const mountedRoots = this.listPersistentGuestRoots(tempDir);

    if (this.runscSession) {
      const current = new Set(this.runscSession.mountedRoots);
      const compatible = mountedRoots.every((root) => current.has(root));
      if (compatible) {
        return this.runscSession;
      }
      await this.close();
    }

    const fabricMount = await this.resolveFabricMount();
    const bundleDir = `${tempDir}/bundle`;
    const runscRoot = this.resolveRunscRootPath();
    await ensureDir(bundleDir);
    await ensureDir(runscRoot);

    const spec = this.buildPersistentRunscSpec(
      tempDir,
      rootfsPath,
      fabricMount,
      mountedRoots,
    );
    await Deno.writeTextFile(
      `${bundleDir}/config.json`,
      JSON.stringify(spec, null, 2),
    );

    const containerId = `brighid-${crypto.randomUUID()}`;
    await this.runRunscCommand(
      runscBinary,
      [
        ...this.baseRunscArgs(runscRoot),
        "create",
        "--bundle",
        bundleDir,
        containerId,
      ],
    );
    await this.runRunscCommand(
      runscBinary,
      [...this.baseRunscArgs(runscRoot), "start", containerId],
    );

    this.runscSession = {
      tempDir,
      bundleDir,
      containerId,
      runscRoot,
      mountedRoots,
      fabricMount,
    };
    return this.runscSession;
  }

  private buildPersistentRunscSpec(
    tempDir: string,
    rootfsPath: string,
    fabricMount: PersistentRunscSession["fabricMount"],
    mountedRoots: string[],
  ): Record<string, unknown> {
    const mounts: Array<Record<string, unknown>> = [
      { destination: "/proc", type: "proc", source: "proc" },
      {
        destination: "/dev",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "strictatime", "mode=755", "size=65536k"],
      },
      {
        destination: this.config.guestWorkspacePath,
        type: "bind",
        source: tempDir,
        options: ["rbind", "rw"],
      },
    ];

    for (const root of mountedRoots) {
      mounts.push({
        destination: `/${root}`,
        type: "bind",
        source: `${tempDir}/${root}`,
        options: ["rbind", "rw"],
      });
    }

    if (fabricMount) {
      mounts.push({
        destination: this.config.fabricGuestPath,
        type: "bind",
        source: fabricMount.hostPath,
        options: ["rbind", "rw"],
      });
    }

    const namespaces: Array<Record<string, unknown>> = [
      { type: "pid" },
      { type: "ipc" },
      { type: "uts" },
      { type: "mount" },
    ];
    if (!this.config.allowNetwork) {
      namespaces.push({ type: "network" });
    }

    const linux: Record<string, unknown> = { namespaces };
    const { uid, gid } = getProcessIds();
    if (uid !== 0) {
      namespaces.push({ type: "user" });
      linux.uidMappings = [{ containerID: 0, hostID: uid, size: 1 }];
      linux.gidMappings = [{ containerID: 0, hostID: gid, size: 1 }];
    }

    return {
      ociVersion: "1.0.0",
      process: {
        terminal: false,
        user: { uid: 0, gid: 0 },
        args: ["/bin/sh", "-lc", "while true; do sleep 3600; done"],
        env: [
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        ],
        cwd: this.config.guestWorkspacePath,
      },
      root: { path: rootfsPath, readonly: true },
      hostname: "brighid-runsc",
      mounts,
      linux,
    };
  }

  private listPersistentGuestRoots(tempDir: string): string[] {
    const roots: string[] = [];
    for (const entry of Deno.readDirSync(tempDir)) {
      if (!entry.isDirectory || entry.name === "bundle") {
        continue;
      }
      roots.push(entry.name);
    }
    roots.sort();
    return roots;
  }

  private baseRunscArgs(runscRoot: string): string[] {
    const args = [
      "--root",
      runscRoot,
      "--ignore-cgroups",
      "--debug",
    ];
    if (!this.config.allowNetwork) {
      args.push("--network=none");
    }
    const { uid } = getProcessIds();
    if (uid !== 0) {
      args.push("--TESTONLY-unsafe-nonroot");
    }
    return args;
  }

  private async runRunscCommand(
    runscBinary: string,
    args: string[],
  ): Promise<void> {
    const output = await new Deno.Command(runscBinary, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (output.code === 0) {
      return;
    }

    const decoder = new TextDecoder();
    throw new Error(
      decoder.decode(output.stderr) || decoder.decode(output.stdout),
    );
  }

  private mapRunscCwd(vfsCwd: string, guestWorkspacePath: string): string {
    if (vfsCwd === "/") {
      return guestWorkspacePath;
    }

    const segments = vfsCwd.split("/").filter(Boolean);
    if (segments.length <= 1) {
      return `${guestWorkspacePath}${vfsCwd}`;
    }

    return vfsCwd;
  }

  private async importWritableChanges(
    vfs: VFS,
    tempDir: string,
    outputLabel: Label,
    options: SandboxExecutionOptions,
  ): Promise<Map<string, Labeled<Uint8Array>>> {
    const modifiedFiles = new Map<string, Labeled<Uint8Array>>();

    if (options.mirrorRootIntoGuest) {
      const imported = await importFromReal(vfs, tempDir, "/", outputLabel);
      for (const vfsPath of imported) {
        const { value, label } = vfs.readFile(vfsPath);
        modifiedFiles.set(vfsPath, { value, label });
      }
      return modifiedFiles;
    }

    for (const writablePath of this.config.allowedWritePaths) {
      try {
        const imported = await importFromReal(
          vfs,
          tempDir,
          writablePath,
          outputLabel,
        );
        for (const vfsPath of imported) {
          const { value, label } = vfs.readFile(vfsPath);
          modifiedFiles.set(vfsPath, { value, label });
        }
      } catch (error) {
        console.error(`Failed to import from ${writablePath}: ${error}`);
      }
    }

    return modifiedFiles;
  }

  /**
   * Stub mode: return a message indicating sandbox is not available
   */
  private executeStub(
    command: string,
    args: string[],
    stdin: Labeled<string> | null,
    inputLabels: Label[],
  ): SandboxResult {
    // Collect all input labels
    const allInputLabels: Label[] = [...inputLabels];
    if (stdin) {
      allInputLabels.push(stdin.label);
    }

    // Compute output label
    const outputLabel = this.computeOutputLabel(allInputLabels);

    const argsStr = args.join(" ");
    const message =
      `[BRIGHID] Sandboxed execution not available in this environment. Command: ${command} ${argsStr}`;

    return {
      stdout: {
        value: "",
        label: outputLabel,
      },
      stderr: {
        value: message,
        label: outputLabel,
      },
      exitCode: 1,
      modifiedFiles: new Map(),
    };
  }

  /**
   * Compute conservative output label from all inputs
   *
   * - Confidentiality: join of all inputs (output might contain any input)
   * - Integrity: intersection of inputs + SandboxedExec atom
   */
  private computeOutputLabel(inputLabels: Label[]): Label {
    let outputLabel: Label;

    if (inputLabels.length === 0) {
      // No inputs - just mark as SandboxedExec
      outputLabel = {
        confidentiality: [],
        integrity: [{ kind: "SandboxedExec" }],
      };
    } else {
      // Join all input labels (union confidentiality, intersect integrity)
      outputLabel = labels.joinAll(inputLabels);
      // Add SandboxedExec to integrity
      outputLabel = labels.endorse(outputLabel, { kind: "SandboxedExec" });
    }

    // If network is allowed, add network provenance
    // (data might have been fetched from or modified by network)
    if (this.config.allowNetwork) {
      outputLabel = {
        ...outputLabel,
        integrity: [
          ...outputLabel.integrity,
          { kind: "NetworkProvenance", tls: false, host: "unknown" },
        ],
      };
    }

    return outputLabel;
  }

  /**
   * Update configuration
   */
  setConfig(config: SandboxedExecConfig): void {
    this.config = config;
  }

  /**
   * Merge additional config options
   */
  mergeConfig(overrides: Partial<SandboxedExecConfig>): void {
    this.config = mergeConfig(this.config, overrides);
  }

  /**
   * Get current configuration
   */
  getConfig(): SandboxedExecConfig {
    return { ...this.config };
  }

  async close(): Promise<void> {
    if (!this.runscSession) {
      return;
    }

    const session = this.runscSession;
    this.runscSession = null;

    const runscBinary = this.resolveRunscBinary();
    if (runscBinary) {
      try {
        await this.runRunscCommand(
          runscBinary,
          [
            ...this.baseRunscArgs(session.runscRoot),
            "delete",
            "--force",
            session.containerId,
          ],
        );
      } catch {
      }
    }

    await session.fabricMount?.cleanup();

    try {
      await Deno.remove(session.tempDir, { recursive: true });
    } catch {
    }
  }

  getPersistentSessionInfo(): {
    containerId: string;
    tempDir: string;
    mountedRoots: string[];
  } | null {
    if (!this.runscSession) {
      return null;
    }

    return {
      containerId: this.runscSession.containerId,
      tempDir: this.runscSession.tempDir,
      mountedRoots: [...this.runscSession.mountedRoots],
    };
  }
}
