import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { refineCfcDirectCommandIntentOnce } from "../src/cfc/direct-command-intent.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc direct command intent test");
const space = signer.did();
const bobDid = "did:key:bob";
const kernelName = "agent-kernel-v1";
const directSurface = "DirectAgentCommand";

describe("CFC direct-command intent refinement", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.abort();
    await runtime.dispose();
    await storageManager.close();
  });

  function createSurfaceIntent(options: {
    readonly user: string;
    readonly role: "direct-command" | "context";
    readonly includeKernelMarker?: boolean;
  }) {
    return createCfcIntentEventEnvelope({
      action: "AssistantSurfaceSubmitted",
      sourceGestureId: `gesture-${options.user}-${options.role}`,
      conditionHash: "Cond.AssistantSurfaceSubmitted",
      parameters: {
        surface: directSurface,
      },
      integrity: [
        {
          type: "https://commonfabric.org/cfc/atom/UserSurfaceInput",
          user: options.user,
          surface: directSurface,
          valueDigest: "H(commandRef)",
        },
        {
          type: "https://commonfabric.org/cfc/atom/PromptSlotBound",
          source: "ref:command",
          role: options.role,
          kernelName,
          subject: options.user,
          surface: directSurface,
        },
        ...(options.includeKernelMarker === false
          ? []
          : [{
            type: "https://commonfabric.org/cfc/atom/Builtin",
            name: kernelName,
          }]),
      ],
    });
  }

  it("refines a root intent from a trusted direct-command surface", () => {
    const sourceIntent = createSurfaceIntent({
      user: space,
      role: "direct-command",
    });

    const rootIntent = refineCfcDirectCommandIntentOnce(
      runtime,
      tx,
      space,
      sourceIntent,
      {
        actingUser: space,
        kernelName,
        requiredSurface: directSurface,
        refinerHash: "sha256:agent-root-refiner",
        operation: "Agent.ResearchAndEmail",
        audience: "agent://local",
        endpoint: "agent.research-email",
        parameters: {
          topic: "hotels in berlin",
          to: "alice@example.com",
        },
        exp: Date.now() + 4_000,
        maxAttempts: 1,
        duration: "short",
      },
    );

    expect(rootIntent).not.toBeNull();
    expect(rootIntent?.operation).toBe("Agent.ResearchAndEmail");
  });

  it("does not refine a root intent from a context-only note surface", () => {
    const sourceIntent = createSurfaceIntent({
      user: space,
      role: "context",
    });

    const rootIntent = refineCfcDirectCommandIntentOnce(
      runtime,
      tx,
      space,
      sourceIntent,
      {
        actingUser: space,
        kernelName,
        requiredSurface: directSurface,
        refinerHash: "sha256:agent-root-refiner",
        operation: "Agent.ResearchAndEmail",
        audience: "agent://local",
        endpoint: "agent.research-email",
        parameters: {
          topic: "hotels in berlin",
          to: "alice@example.com",
        },
        exp: Date.now() + 4_000,
        maxAttempts: 1,
        duration: "short",
      },
    );

    expect(rootIntent).toBeNull();
  });

  it("does not treat another user's direct command as Alice authority", () => {
    const sourceIntent = createSurfaceIntent({
      user: bobDid,
      role: "direct-command",
    });

    const rootIntent = refineCfcDirectCommandIntentOnce(
      runtime,
      tx,
      space,
      sourceIntent,
      {
        actingUser: space,
        kernelName,
        requiredSurface: directSurface,
        refinerHash: "sha256:agent-root-refiner",
        operation: "Agent.ResearchAndEmail",
        audience: "agent://local",
        endpoint: "agent.research-email",
        parameters: {
          topic: "hotels in berlin",
          to: "alice@example.com",
        },
        exp: Date.now() + 4_000,
        maxAttempts: 1,
        duration: "short",
      },
    );

    expect(rootIntent).toBeNull();
  });

  it("fails closed when the trusted kernel marker is missing", () => {
    const sourceIntent = createSurfaceIntent({
      user: space,
      role: "direct-command",
      includeKernelMarker: false,
    });

    const rootIntent = refineCfcDirectCommandIntentOnce(
      runtime,
      tx,
      space,
      sourceIntent,
      {
        actingUser: space,
        kernelName,
        requiredSurface: directSurface,
        refinerHash: "sha256:agent-root-refiner",
        operation: "Agent.ResearchAndEmail",
        audience: "agent://local",
        endpoint: "agent.research-email",
        parameters: {
          topic: "hotels in berlin",
          to: "alice@example.com",
        },
        exp: Date.now() + 4_000,
        maxAttempts: 1,
        duration: "short",
      },
    );

    expect(rootIntent).toBeNull();
  });
});
