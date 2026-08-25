import type { GithubClient } from "@commonfabric/github-connector/client";
import type { GithubFabricTarget } from "@commonfabric/github-connector/fabric";
import type { GithubPullRequestCollection } from "@commonfabric/github-connector/types";
import type { GithubPullRequest } from "@commonfabric/github-connector/types";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { GithubHost } from "../src/host.ts";

class FakeTarget {
  readonly collections: GithubPullRequestCollection[] = [];
  readonly healthValues: object[] = [];
  priorPullRequests: GithubPullRequest[] = [];

  readPullRequests(): Promise<GithubPullRequest[]> {
    return Promise.resolve(structuredClone(this.priorPullRequests));
  }

  publish(collection: GithubPullRequestCollection): Promise<number> {
    this.collections.push(structuredClone(collection));
    return Promise.resolve(collection.pullRequests.length);
  }

  publishHealth(value: object): Promise<void> {
    this.healthValues.push(structuredClone(value));
    return Promise.resolve();
  }

  indexCellId(): string {
    return "index";
  }

  healthCellId(): string {
    return "health";
  }
}

describe("GithubHost", () => {
  describe("instance members", () => {
    describe("synchronize()", () => {
      it("publishes a complete collection and ready health", async () => {
        const collection: GithubPullRequestCollection = {
          viewer: "ianh",
          observedAt: "2026-08-21T00:00:00.000Z",
          pullRequests: [],
        };
        const target = new FakeTarget();
        target.priorPullRequests = [{ id: "prior" }] as GithubPullRequest[];
        let prior: ReadonlyArray<GithubPullRequest> | undefined;
        const client = {
          collectOpenPullRequests: (
            _signal?: AbortSignal,
            previouslyKnown?: ReadonlyArray<GithubPullRequest>,
          ) => {
            prior = previouslyKnown;
            return Promise.resolve(collection);
          },
        } as unknown as GithubClient;
        const host = new GithubHost({
          client,
          target: target as unknown as GithubFabricTarget,
          spaceDid: "did:key:test",
          clock: () => new Date("2026-08-21T00:00:00.000Z"),
        });

        await host.start();
        expect(await host.synchronize("initial")).toBe(0);

        expect(target.collections).toEqual([collection]);
        expect(prior).toEqual(target.priorPullRequests);
        expect(host.health().status).toBe("ready");
        expect(host.health().sync?.status).toBe("complete");
      });

      it("retains the last index when GitHub collection fails", async () => {
        const client = {
          collectOpenPullRequests: () => Promise.reject(new Error("offline")),
        } as unknown as GithubClient;
        const target = new FakeTarget();
        const host = new GithubHost({
          client,
          target: target as unknown as GithubFabricTarget,
          spaceDid: "did:key:test",
          clock: () => new Date("2026-08-21T00:00:00.000Z"),
        });

        await host.start();
        await expect(host.synchronize("periodic")).rejects.toThrow("offline");

        expect(target.collections).toEqual([]);
        expect(host.health().status).toBe("degraded");
        expect(host.health().sync?.status).toBe("failed");
        expect(host.health().sync?.error).toBe("offline");
      });
    });
  });
});
