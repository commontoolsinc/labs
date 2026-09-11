/**
 * Checks host trust options through worker construction and display admission.
 * Real cells and ACL changes drive an in-process renderer over emulated storage.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import type { VDomOp } from "@commonfabric/html/vdom-ops";
import {
  WorkerReconciler,
  type WorkerRenderNode,
} from "@commonfabric/html/worker";
import { createSession, Identity } from "@commonfabric/identity";
import { createRuntimeClientOptions } from "@commonfabric/lib-shell/runtime";
import {
  Runtime,
  runtimePresets,
  RuntimeTelemetry,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "../../../runner/test/cfc-seed-envelope.ts";

import {
  browserWorkerParamsFromInitializationData,
  renderConfidentialityResolverFor,
  renderMembershipProviderFor,
} from "@/backends/runtime-processor.ts";

/** Builds the worker's effective runtime from host options over local storage. */
function createWorkerRuntime(
  options: ReturnType<typeof createRuntimeClientOptions>,
): Runtime {
  const storageManager = StorageManager.emulate({ as: options.identity });
  const params = browserWorkerParamsFromInitializationData(
    {
      ...options,
      apiUrl: options.apiUrl.toString(),
      identity: options.identity.keyPair,
      spaceIdentity: options.spaceIdentity?.keyPair,
    },
    storageManager,
    new RuntimeTelemetry(),
  );
  return new Runtime(runtimePresets.browserWorker(params));
}

/** Text sent to the host, including updates to an existing text node. */
function emittedText(ops: readonly VDomOp[]): string[] {
  return ops.filter((op) => op.op === "create-text" || op.op === "update-text")
    .map((op) => op.text);
}

describe("render-audience", () => {
  describe("effective worker trust", () => {
    for (const trustSnapshot of [undefined, null]) {
      it(`uses session-principal transaction trust for \`${trustSnapshot}\` host trust`, async () => {
        const identity = await Identity.generate({ implementation: "noble" });
        const session = await createSession({
          identity,
          spaceDid: identity.did(),
        });
        const options = createRuntimeClientOptions({
          session,
          apiUrl: new URL("http://localhost/"),
          trustSnapshot,
        });
        await using runtime = createWorkerRuntime(options);
        const tx = runtime.edit();
        try {
          const trust = tx.getCfcState().trustSnapshot;
          expect(trust?.id).toBe(`principal:${identity.did()}`);
          expect(trust?.actingPrincipal).toBe(identity.did());
          if (trustSnapshot === null) {
            expect(trust?.revision).toBeDefined();
          }
        } finally {
          tx.abort();
        }
      });
    }

    it("keeps a supplied snapshot unnamed for transactions while rendering as the session identity", async () => {
      const identity = await Identity.generate({ implementation: "noble" });
      const session = await createSession({
        identity,
        spaceDid: identity.did(),
      });
      const trustSnapshot = { id: "unnamed-host-snapshot" };
      const options = createRuntimeClientOptions({
        session,
        apiUrl: new URL("http://localhost/"),
        cfcRenderCeiling: true,
        trustSnapshot,
      });
      await using runtime = createWorkerRuntime(options);
      const tx = runtime.edit();
      try {
        expect(tx.getCfcState().trustSnapshot).toEqual(trustSnapshot);
        expect(tx.getCfcState().trustSnapshot?.actingPrincipal).toBeUndefined();
      } finally {
        tx.abort();
      }
      const membership = renderMembershipProviderFor(
        runtime,
        identity,
        options.renderConfidentialityCeiling,
      );
      expect(membership?.readerRole(identity.did())).toBe("owner");
      expect(options.renderConfidentialityCeiling?.atoms).toContainEqual(
        cfcAtom.user(identity.did()),
      );
    });
  });

  describe("delegated rendering", () => {
    for (const namedSpace of [false, true]) {
      it(`renders the session's ${namedSpace ? "derived" : "identity"} workspace only while the delegate has an ACL grant`, async () => {
        const identity = await Identity.generate({ implementation: "noble" });
        const delegate = await Identity.generate({ implementation: "noble" });
        const session = await createSession({
          identity,
          ...(namedSpace ? { spaceName: "private-workspace" } : {
            spaceDid: identity.did(),
          }),
        });
        const options = createRuntimeClientOptions({
          session,
          apiUrl: new URL("http://localhost/"),
          cfcRenderCeiling: true,
          trustSnapshot: {
            id: `principal:${delegate.did()}`,
            actingPrincipal: delegate.did(),
          },
        });
        await using runtime = createWorkerRuntime(options);
        const seed = runtime.edit();
        writeSeedEnvelopeDoc(seed, session.space);
        const notes = [
          { text: "Workspace note", atom: cfcAtom.space(session.space) },
          { text: "Owner identity note", atom: cfcAtom.user(identity.did()) },
          {
            text: "Owner personal-space note",
            atom: cfcAtom.personalSpace(identity.did()),
          },
          { text: "Owner DID note", atom: identity.did() },
          { text: "Delegate note", atom: cfcAtom.user(delegate.did()) },
        ].map(({ text, atom }) => {
          const cell = runtime.getCell<WorkerRenderNode>(
            session.space,
            text,
            undefined,
            seed,
          );
          seed.writeOrThrow({
            space: session.space,
            id: cell.getAsNormalizedFullLink().id!,
            type: "application/json",
            path: [],
          }, {
            value: text,
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: [{ path: [], label: { confidentiality: [atom] } }],
              },
            },
          });
          return cell;
        });
        expect((await seed.commit()).error).toBeUndefined();

        /** Writes the ACL without reading labeled notes into the transaction. */
        async function setDelegateRead(granted: boolean): Promise<void> {
          const tx = runtime.edit();
          tx.writeOrThrow({
            space: session.space,
            id: `of:${session.space}`,
            type: "application/json",
            path: [],
          }, {
            value: {
              [identity.did()]: "OWNER",
              ...(granted ? { [delegate.did()]: "READ" } : {}),
            },
          });
          expect((await tx.commit()).error).toBeUndefined();
          await runtime.storageManager.synced();
          await runtime.idle();
        }

        await setDelegateRead(false);
        const ceiling = options.renderConfidentialityCeiling;
        const membership = renderMembershipProviderFor(
          runtime,
          identity,
          ceiling,
        );
        const resolver = renderConfidentialityResolverFor(
          runtime,
          identity,
          ceiling,
          options.spaceDid,
          membership,
        );
        const ops: VDomOp[] = [];
        const allText: string[] = [];
        const reconciler = new WorkerReconciler({
          onOps: (batch) => {
            ops.push(...batch);
            allText.push(...emittedText(batch));
          },
          renderDeclassificationPolicy: options.renderDeclassificationPolicy,
          renderConfidentialityCeiling: ceiling,
          resolveRenderConfidentiality: resolver,
          membershipProvider: membership,
        });
        const cancel = reconciler.mount({
          type: "vnode",
          name: "div",
          props: {},
          children: notes,
        });
        try {
          await runtime.idle();
          reconciler.flush();
          expect(membership?.readerRole(session.space)).toBeNull();
          expect(emittedText(ops)).toContain("Delegate note");
          expect(emittedText(ops)).toContain("Content hidden by policy");
          expect(emittedText(ops)).not.toContain("Workspace note");
          ops.length = 0;
          await setDelegateRead(true);
          reconciler.flush();
          expect(membership?.readerRole(session.space)).toBe("reader");
          expect(emittedText(ops)).toContain("Workspace note");
          const disclosed = ops.filter((op) => op.op === "create-text")
            .find((op) => op.text === "Workspace note");
          expect(disclosed).toBeDefined();

          ops.length = 0;
          await setDelegateRead(false);
          reconciler.flush();
          expect(membership?.readerRole(session.space)).toBeNull();
          expect(emittedText(ops)).toContain("Content hidden by policy");
          expect(emittedText(ops)).not.toContain("Workspace note");
          expect(ops).toContainEqual({
            op: "remove-node",
            nodeId: disclosed!.nodeId,
          });
          for (
            const text of [
              "Owner identity note",
              "Owner personal-space note",
              "Owner DID note",
            ]
          ) {
            expect(allText).not.toContain(text);
          }
        } finally {
          cancel();
        }
      });
    }
  });
});
