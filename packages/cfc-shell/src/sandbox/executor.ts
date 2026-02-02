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
import { SandboxedExecConfig, defaultConfig, mergeConfig } from "./config.ts";
import { exportToReal, importFromReal } from "./vfs-bridge.ts";

/** Check for permission/capability errors across Deno versions */
function isPermissionError(e: unknown): boolean {
  return e instanceof Deno.errors.PermissionDenied ||
    ((Deno.errors as any).NotCapable != null && e instanceof (Deno.errors as any).NotCapable);
}

export interface SandboxResult {
  stdout: Labeled<string>;
  stderr: Labeled<string>;
  exitCode: number;
  /** Files modified in writable paths */
  modifiedFiles: Map<string, Labeled<Uint8Array>>;
}

export class SandboxedExecutor {
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
  ): Promise<SandboxResult> {
    // Check if Deno.Command is available
    const hasDenoCommand = typeof Deno !== "undefined" && typeof Deno.Command === "function";

    if (!hasDenoCommand) {
      // Stub mode: return a result indicating sandbox is not available
      return this.executeStub(command, args, stdin, inputLabels);
    }

    // Create temp directory for sandbox workspace
    let tempDir: string;
    try {
      tempDir = await Deno.makeTempDir({ prefix: "cfc-sandbox-" });
    } catch (e: unknown) {
      if (isPermissionError(e)) {
        return this.executeStub(command, args, stdin, inputLabels);
      }
      throw e;
    }

    try {
      // Export VFS files to temp directory
      const exportedLabels = await exportToReal(vfs, exportPaths, tempDir);

      // Collect all input labels: stdin + exported files
      const allInputLabels: Label[] = [...inputLabels];
      if (stdin) {
        allInputLabels.push(stdin.label);
      }
      for (const label of exportedLabels.values()) {
        allInputLabels.push(label);
      }

      // Compute output label conservatively
      const outputLabel = this.computeOutputLabel(allInputLabels);

      // Prepare environment variables
      const env: Record<string, string> = {
        ...this.config.env,
        // Add sandbox-specific env vars
        CFC_SANDBOX: "true",
        CFC_SANDBOX_ROOT: tempDir,
      };

      // Create abort controller for timeout
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        abortController.abort();
      }, this.config.timeout);

      try {
        // Execute command
        const cmd = new Deno.Command(command, {
          args,
          stdin: stdin ? "piped" : "null",
          stdout: "piped",
          stderr: "piped",
          env,
          cwd: tempDir,
          signal: abortController.signal,
        });

        let process;
        try {
          process = cmd.spawn();
        } catch (e: unknown) {
          clearTimeout(timeoutId);
          // Fall back to stub mode if we lack permission or the command doesn't exist
          if (isPermissionError(e) || e instanceof Deno.errors.NotFound) {
            return this.executeStub(command, args, stdin, inputLabels);
          }
          throw e;
        }

        // Write stdin if provided
        if (stdin && process.stdin) {
          const writer = process.stdin.getWriter();
          const encoder = new TextEncoder();
          await writer.write(encoder.encode(stdin.value));
          await writer.close();
        }

        // Wait for completion
        const output = await process.output();

        clearTimeout(timeoutId);

        // Decode stdout and stderr
        const decoder = new TextDecoder();
        const stdoutText = decoder.decode(output.stdout);
        const stderrText = decoder.decode(output.stderr);

        // Import modified files back to VFS
        const modifiedFiles = new Map<string, Labeled<Uint8Array>>();
        for (const writablePath of this.config.allowedWritePaths) {
          try {
            const imported = await importFromReal(vfs, tempDir, writablePath, outputLabel);
            // Read imported files back with their labels
            for (const vfsPath of imported) {
              const { value, label } = vfs.readFile(vfsPath);
              modifiedFiles.set(vfsPath, { value, label });
            }
          } catch (error) {
            console.error(`Failed to import from ${writablePath}: ${error}`);
          }
        }

        return {
          stdout: { value: stdoutText, label: outputLabel },
          stderr: { value: stderrText, label: outputLabel },
          exitCode: output.code,
          modifiedFiles,
        };
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error && error.name === "AbortError") {
          // Timeout occurred
          return {
            stdout: {
              value: "",
              label: outputLabel,
            },
            stderr: {
              value: `[CFC-SHELL] Command timed out after ${this.config.timeout}ms`,
              label: outputLabel,
            },
            exitCode: 124, // Standard timeout exit code
            modifiedFiles: new Map(),
          };
        }

        // Other error
        throw error;
      }
    } finally {
      // Clean up temp directory
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch (error) {
        console.error(`Failed to clean up temp directory ${tempDir}: ${error}`);
      }
    }
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
    const message = `[CFC-SHELL] Sandboxed execution not available in this environment. Command: ${command} ${argsStr}`;

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
}
