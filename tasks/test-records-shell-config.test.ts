import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import type { Environment } from "@commonfabric/test-support/records";

import {
  expandHome,
  exportFromProfiles,
  exportLine,
  homeRelative,
  MARKER,
  parseSetting,
  profileCandidates,
  reloadHint,
  shellKind,
} from "./test-records-shell-config.ts";

const VARIABLE = "CF_TEST_RECORDS_KEY_FILE";

function environment(values: Record<string, string>): Environment {
  return (name) => values[name];
}

describe("test-records-shell-config", () => {
  let home: string;

  beforeEach(async () => {
    home = await Deno.makeTempDir({ prefix: "test-records-profile-" });
  });

  afterEach(async () => {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  });

  describe("shellKind()", () => {
    it("returns the family named by SHELL", () => {
      expect(shellKind(environment({ SHELL: "/bin/zsh" }))).toBe("zsh");
      expect(shellKind(environment({ SHELL: "/usr/bin/bash" }))).toBe("bash");
      expect(shellKind(environment({ SHELL: "/opt/homebrew/bin/fish" })))
        .toBe("fish");
    });

    it("returns posix for an unset or unfamiliar shell", () => {
      expect(shellKind(environment({}))).toBe("posix");
      expect(shellKind(environment({ SHELL: "/bin/ksh" }))).toBe("posix");
    });
  });

  describe("profileCandidates()", () => {
    it("returns the zsh profile under ZDOTDIR when one is set", () => {
      expect(
        profileCandidates(
          environment({ SHELL: "/bin/zsh", HOME: "/h", ZDOTDIR: "/z" }),
          "linux",
        ),
      ).toEqual(["/z/.zshrc"]);
    });

    it("returns the home zsh profile without ZDOTDIR", () => {
      expect(
        profileCandidates(environment({ SHELL: "/bin/zsh", HOME: "/h" })),
      ).toEqual(["/h/.zshrc"]);
    });

    it("orders the bash profiles by the ones the platform reads first", () => {
      const env = environment({ SHELL: "/bin/bash", HOME: "/h" });
      expect(profileCandidates(env, "darwin")).toEqual([
        "/h/.bash_profile",
        "/h/.bashrc",
      ]);
      expect(profileCandidates(env, "linux")).toEqual([
        "/h/.bashrc",
        "/h/.bash_profile",
      ]);
    });

    it("returns the fish configuration under the configuration home", () => {
      expect(
        profileCandidates(
          environment({
            SHELL: "/bin/fish",
            HOME: "/h",
            XDG_CONFIG_HOME: "/c",
          }),
        ),
      ).toEqual(["/c/fish/config.fish"]);
      expect(
        profileCandidates(environment({ SHELL: "/bin/fish", HOME: "/h" })),
      ).toEqual(["/h/.config/fish/config.fish"]);
    });

    it("returns the shared profile for anything else", () => {
      expect(profileCandidates(environment({ HOME: "/h" }))).toEqual([
        "/h/.profile",
      ]);
    });

    it("returns nothing without a home directory", () => {
      expect(profileCandidates(environment({ SHELL: "/bin/zsh" }))).toEqual([]);
    });
  });

  describe("exportLine()", () => {
    it("returns an export for posix shells", () => {
      expect(exportLine("zsh", VARIABLE, "/k.json")).toBe(
        `export ${VARIABLE}="/k.json"`,
      );
    });

    it("returns a global set for fish", () => {
      expect(exportLine("fish", VARIABLE, "/k.json")).toBe(
        `set -gx ${VARIABLE} "/k.json"`,
      );
    });

    it("writes a path under the home directory through $HOME", () => {
      expect(exportLine("zsh", VARIABLE, "/h/.config/k.json", "/h")).toBe(
        `export ${VARIABLE}="$HOME/.config/k.json"`,
      );
    });

    it("escapes what a shell would otherwise act on", () => {
      expect(exportLine("zsh", VARIABLE, '/h/$(id)/`id`/"q"/b\\s/k.json', "/h"))
        .toBe(
          `export ${VARIABLE}=` +
            '"$HOME/\\$(id)/\\`id\\`/\\"q\\"/b\\\\s/k.json"',
        );
    });

    it("escapes for fish, which has no backtick", () => {
      expect(exportLine("fish", VARIABLE, "/h/$(id)/`id`/k.json", "/h")).toBe(
        `set -gx ${VARIABLE} "$HOME/\\$(id)/\`id\`/k.json"`,
      );
    });
  });

  describe("expandHome()", () => {
    it("returns the path a value naming $HOME stands for", () => {
      expect(expandHome("$HOME/.config/k.json", "/h")).toBe(
        "/h/.config/k.json",
      );
      expect(expandHome("${HOME}/k.json", "/h")).toBe("/h/k.json");
    });

    it("returns any other value unchanged", () => {
      expect(expandHome("/etc/k.json", "/h")).toBe("/etc/k.json");
      expect(expandHome("$HOMEBREW/k.json", "/h")).toBe("$HOMEBREW/k.json");
      expect(expandHome("$HOME/k.json", undefined)).toBe("$HOME/k.json");
    });
  });

  describe("homeRelative()", () => {
    it("returns a path under the home directory through $HOME", () => {
      expect(homeRelative("/h/.config/k.json", "/h")).toBe(
        "$HOME/.config/k.json",
      );
      expect(homeRelative("/h/.config/k.json", "/h/")).toBe(
        "$HOME/.config/k.json",
      );
    });

    it("returns a path outside the home directory unchanged", () => {
      expect(homeRelative("/etc/k.json", "/h")).toBe("/etc/k.json");
      expect(homeRelative("/home2/k.json", "/h")).toBe("/home2/k.json");
      expect(homeRelative("/h/k.json", undefined)).toBe("/h/k.json");
    });
  });

  describe("parseSetting()", () => {
    it("returns the value an export carries", () => {
      expect(parseSetting(`export ${VARIABLE}="/k.json"\n`, VARIABLE)).toEqual({
        line: `export ${VARIABLE}="/k.json"`,
        exported: true,
        value: "/k.json",
      });
    });

    it("reports an assignment that is never exported", () => {
      expect(parseSetting(`${VARIABLE}=/k.json\n`, VARIABLE)).toEqual({
        line: `${VARIABLE}=/k.json`,
        exported: false,
        value: "/k.json",
      });
    });

    it("reads fish's set, exported only with -x", () => {
      expect(parseSetting(`set -gx ${VARIABLE} "/k.json"\n`, VARIABLE)).toEqual(
        {
          line: `set -gx ${VARIABLE} "/k.json"`,
          exported: true,
          value: "/k.json",
        },
      );
      expect(parseSetting(`set -g ${VARIABLE} "/k.json"\n`, VARIABLE)?.exported)
        .toBe(false);
    });

    it("takes one level of quoting off the value", () => {
      expect(parseSetting(`export ${VARIABLE}='/k.json'\n`, VARIABLE)?.value)
        .toBe("/k.json");
      expect(
        parseSetting(`export ${VARIABLE}="/a\\$b/k.json"\n`, VARIABLE)?.value,
      ).toBe("/a$b/k.json");
    });

    it("returns undefined for a mention that sets nothing", () => {
      expect(parseSetting(`# ${VARIABLE} is the opt-in\n`, VARIABLE))
        .toBeUndefined();
      expect(parseSetting(`echo "$${VARIABLE}"\n`, VARIABLE)).toBeUndefined();
      expect(parseSetting("", VARIABLE)).toBeUndefined();
    });
  });

  describe("exportFromProfiles()", () => {
    function zsh(): Environment {
      return environment({ SHELL: "/bin/zsh", HOME: home });
    }

    it("appends the marked line to the profile", async () => {
      const key = join(home, ".config", "k.json");
      const updates = await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      expect(updates).toEqual([
        { path: join(home, ".zshrc"), outcome: "added" },
      ]);
      expect(await Deno.readTextFile(join(home, ".zshrc"))).toBe(
        `${MARKER}\nexport ${VARIABLE}="$HOME/.config/k.json"\n`,
      );
    });

    it("keeps an existing profile's contents and its trailing newline", async () => {
      await Deno.writeTextFile(join(home, ".zshrc"), "alias l=ls");
      const key = join(home, ".config", "k.json");

      await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      expect(await Deno.readTextFile(join(home, ".zshrc"))).toBe(
        `alias l=ls\n\n${MARKER}\nexport ${VARIABLE}="$HOME/.config/k.json"\n`,
      );
    });

    it("reports the same value as already present and writes nothing", async () => {
      const key = join(home, ".config", "k.json");
      await exportFromProfiles(VARIABLE, key, zsh(), "darwin");
      const before = await Deno.readTextFile(join(home, ".zshrc"));

      const updates = await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      expect(updates).toEqual([
        { path: join(home, ".zshrc"), outcome: "present" },
      ]);
      expect(await Deno.readTextFile(join(home, ".zshrc"))).toBe(before);
    });

    it("reports a value that only starts the same as a conflict", async () => {
      const key = join(home, ".config", "k.json");
      await Deno.writeTextFile(
        join(home, ".zshrc"),
        `export ${VARIABLE}="${key}.backup"\n`,
      );

      const updates = await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      expect(updates[0]?.outcome).toBe("conflict");
    });

    it("reports an assignment that is never exported", async () => {
      const key = join(home, ".config", "k.json");
      await Deno.writeTextFile(
        join(home, ".zshrc"),
        `${VARIABLE}="$HOME/.config/k.json"\n`,
      );

      const updates = await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      expect(updates).toEqual([{
        path: join(home, ".zshrc"),
        outcome: "unexported",
        existing: `${VARIABLE}="$HOME/.config/k.json"`,
      }]);
    });

    it("reports a missing login profile rather than creating one", async () => {
      await Deno.writeTextFile(join(home, ".bashrc"), "");
      const env = environment({ SHELL: "/bin/bash", HOME: home });

      const updates = await exportFromProfiles(
        VARIABLE,
        join(home, "k.json"),
        env,
        "darwin",
      );

      expect(updates).toEqual([
        { path: join(home, ".bash_profile"), outcome: "absent" },
        { path: join(home, ".bashrc"), outcome: "added" },
      ]);
      // Creating it is what stops a login shell reading .profile.
      await expect(Deno.stat(join(home, ".bash_profile"))).rejects.toThrow();
    });

    it("reports a line pointing elsewhere as a conflict", async () => {
      await Deno.writeTextFile(
        join(home, ".zshrc"),
        `export ${VARIABLE}="/somewhere/else.json"\n`,
      );
      const key = join(home, ".config", "k.json");

      const updates = await exportFromProfiles(VARIABLE, key, zsh(), "darwin");

      expect(updates).toEqual([{
        path: join(home, ".zshrc"),
        outcome: "conflict",
        existing: `export ${VARIABLE}="/somewhere/else.json"`,
      }]);
    });

    it("updates every bash profile that exists", async () => {
      await Deno.writeTextFile(join(home, ".bashrc"), "");
      await Deno.writeTextFile(join(home, ".bash_profile"), "");
      const env = environment({ SHELL: "/bin/bash", HOME: home });

      const updates = await exportFromProfiles(
        VARIABLE,
        join(home, "k.json"),
        env,
        "darwin",
      );

      expect(updates.map((update) => update.path)).toEqual([
        join(home, ".bash_profile"),
        join(home, ".bashrc"),
      ]);
      for (const update of updates) expect(update.outcome).toBe("added");
    });

    it("creates the first profile when the shell has none", async () => {
      const env = environment({ SHELL: "/bin/fish", HOME: home });

      const updates = await exportFromProfiles(
        VARIABLE,
        join(home, "k.json"),
        env,
        "linux",
      );

      const path = join(home, ".config", "fish", "config.fish");
      expect(updates).toEqual([{ path, outcome: "added" }]);
      expect(await Deno.readTextFile(path)).toBe(
        `${MARKER}\nset -gx ${VARIABLE} "$HOME/k.json"\n`,
      );
    });

    it("returns nothing when there is no home directory to write in", async () => {
      expect(
        await exportFromProfiles(VARIABLE, "/k.json", environment({})),
      ).toEqual([]);
    });
  });

  describe("reloadHint()", () => {
    it("returns the command that loads the profile", () => {
      expect(reloadHint("/h/.zshrc", "zsh")).toBe(". /h/.zshrc");
      expect(reloadHint("/h/config.fish", "fish")).toBe(
        "source /h/config.fish",
      );
    });
  });
});
