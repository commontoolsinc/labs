import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  DASHBOARD_MESSAGE_LIFETIME_MS,
  DASHBOARD_MESSAGE_VISIBLE_MS,
  dashboardMessageOpacity,
  DashboardMessageStore,
  normalizeDashboardMessageText,
} from "../dashboard-message.ts";

describe("dashboard-message", () => {
  const directories: string[] = [];

  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      await Deno.remove(directory, { recursive: true });
    }
  });

  describe("dashboardMessageOpacity()", () => {
    it("returns full opacity through the first two hours", () => {
      expect(dashboardMessageOpacity(1_000, 1_000)).toBe(1);
      expect(
        dashboardMessageOpacity(
          1_000,
          1_000 + DASHBOARD_MESSAGE_VISIBLE_MS,
        ),
      ).toBe(1);
    });

    it("returns half opacity halfway through the four-hour fade", () => {
      expect(
        dashboardMessageOpacity(
          1_000,
          1_000 + DASHBOARD_MESSAGE_VISIBLE_MS + 2 * 60 * 60 * 1_000,
        ),
      ).toBe(0.5);
    });

    it("returns zero opacity after the six-hour lifetime", () => {
      expect(
        dashboardMessageOpacity(
          1_000,
          1_000 + DASHBOARD_MESSAGE_LIFETIME_MS,
        ),
      ).toBe(0);
    });
  });

  describe("normalizeDashboardMessageText()", () => {
    it("returns trimmed single-line text", () => {
      expect(normalizeDashboardMessageText("  hello\n  dashboard  ")).toBe(
        "hello dashboard",
      );
    });
  });

  describe("DashboardMessageStore", () => {
    it("reloads the saved message from the dashboard cache", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "dashboard-message-",
      });
      directories.push(directory);
      const file = `${directory}/message.json`;
      const now = 12_345;
      const first = new DashboardMessageStore({ file, now: () => now });

      expect(await first.set("Team lunch at noon")).toEqual({
        text: "Team lunch at noon",
        updatedAt: now,
        revision: 1,
      });

      const reloaded = new DashboardMessageStore({ file, now: () => now });
      expect((await reloaded.refresh()).message).toEqual({
        text: "Team lunch at noon",
        updatedAt: now,
        revision: 1,
      });
    });

    it("loads a version-one message written before revisions were added", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "dashboard-message-",
      });
      directories.push(directory);
      const file = `${directory}/message.json`;
      await Deno.writeTextFile(
        file,
        JSON.stringify({
          version: 1,
          text: "Existing announcement",
          updatedAt: 12_345,
        }),
      );

      const store = new DashboardMessageStore({ file, now: () => 12_345 });
      expect((await store.refresh()).message).toEqual({
        text: "Existing announcement",
        updatedAt: 12_345,
        revision: 0,
      });
    });

    it("replaces expired text with the persisted empty string", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "dashboard-message-",
      });
      directories.push(directory);
      const file = `${directory}/message.json`;
      let now = 12_345;
      const store = new DashboardMessageStore({ file, now: () => now });
      await store.set("Deploying");

      now += DASHBOARD_MESSAGE_LIFETIME_MS;
      expect(await store.refresh()).toEqual({
        message: { text: "", updatedAt: null, revision: 2 },
        expired: true,
      });
      expect(JSON.parse(await Deno.readTextFile(file))).toEqual({
        version: 1,
        text: "",
        updatedAt: null,
        revision: 2,
      });
    });

    it("keeps the prior message when persistence fails", async () => {
      const store = new DashboardMessageStore({
        file: "/missing/dashboard-message.json",
        reportError: () => {},
      });

      await expect(store.set("Not persisted")).rejects.toThrow(
        "Could not save the dashboard message",
      );
      expect((await store.refresh()).message).toEqual({
        text: "",
        updatedAt: null,
        revision: 0,
      });
    });
  });
});
