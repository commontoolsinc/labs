import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { GithubClient } from "../src/client.ts";

function pullRequest(number: number, checkState = "SUCCESS") {
  return {
    id: `PR_${number}`,
    number,
    url: `https://github.com/common/labs/pull/${number}`,
    title: `Pull request ${number}`,
    isDraft: false,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    baseRefName: "main",
    baseRefOid: "base",
    headRefName: `feature-${number}`,
    headRefOid: `head-${number}`,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    repository: {
      nameWithOwner: "common/labs",
      url: "https://github.com/common/labs",
    },
    headRepository: {
      nameWithOwner: "common/labs",
      url: "https://github.com/common/labs",
    },
    statusCheckRollup: { state: checkState },
  };
}

function response(
  nodes: unknown[],
  hasNextPage: boolean,
  endCursor: string | null,
  totalCount = nodes.length,
) {
  return {
    data: {
      viewer: {
        login: "ianh",
        pullRequests: {
          totalCount,
          pageInfo: { hasNextPage, endCursor },
          nodes,
        },
      },
    },
  };
}

describe("GithubClient", () => {
  describe("instance members", () => {
    describe("collectOpenPullRequests()", () => {
      it("returns one complete collection across every page", async () => {
        const requests: Array<Record<string, unknown>> = [];
        const pages = [
          response([pullRequest(2)], true, "next", 2),
          response([pullRequest(1, "PENDING")], false, null, 2),
        ];
        const client = new GithubClient((request) => {
          requests.push(request.variables);
          return Promise.resolve(pages.shift());
        }, () => new Date("2026-08-21T12:00:00.000Z"));

        const result = await client.collectOpenPullRequests();

        expect(requests).toEqual([{ after: null }, { after: "next" }]);
        expect(result.viewer).toBe("ianh");
        expect(result.observedAt).toBe("2026-08-21T12:00:00.000Z");
        expect(result.pullRequests.map(({ number, status }) => ({
          number,
          status,
        }))).toEqual([
          { number: 2, status: "green-and-can-land" },
          { number: 1, status: "tests-running" },
        ]);
      });

      it("rejects the collection when a later page fails", async () => {
        let requestCount = 0;
        const client = new GithubClient(() => {
          requestCount++;
          return requestCount === 1
            ? Promise.resolve(response([pullRequest(2)], true, "next", 2))
            : Promise.reject(new Error("offline"));
        });

        await expect(client.collectOpenPullRequests()).rejects.toThrow(
          "offline",
        );
      });

      it("rejects a page that claims another page without a cursor", async () => {
        const client = new GithubClient(() =>
          Promise.resolve(response([], true, null))
        );

        await expect(client.collectOpenPullRequests()).rejects.toThrow(
          "no next cursor",
        );
      });

      it("rejects a repeated pagination cursor", async () => {
        const pages = [
          response([pullRequest(1)], true, "same", 2),
          response([pullRequest(2)], true, "same", 2),
        ];
        const client = new GithubClient(() => Promise.resolve(pages.shift()));

        await expect(client.collectOpenPullRequests()).rejects.toThrow(
          "repeated a pull-request cursor",
        );
      });

      it("retains inaccessible prior pull requests and removes closed ones", async () => {
        const prior = await new GithubClient(() =>
          Promise.resolve(response(
            [
              pullRequest(1),
              pullRequest(2),
            ],
            false,
            null,
            2,
          ))
        ).collectOpenPullRequests();
        const responses = [
          response([], false, null, 0),
          {
            data: {
              nodes: [
                null,
                { __typename: "PullRequest", id: "PR_2", state: "CLOSED" },
              ],
            },
          },
        ];
        const client = new GithubClient(() =>
          Promise.resolve(responses.shift())
        );

        const result = await client.collectOpenPullRequests(
          undefined,
          prior.pullRequests,
        );

        expect(result.pullRequests.map(({ number, visibility, status }) => ({
          number,
          visibility,
          status,
        }))).toEqual([{
          number: 1,
          visibility: "unknown",
          status: "visibility-unknown",
        }]);
      });
    });
  });
});
