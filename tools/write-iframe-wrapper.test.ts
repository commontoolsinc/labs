import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

const ROOT = resolve(import.meta.dirname!, "..");
const SCRIPT = resolve(import.meta.dirname!, "write-iframe-wrapper.ts");
const decoder = new TextDecoder();

async function removeDirectory(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function runDeno(args: (lockPath: string) => string[]) {
  return await runDenoCommandWithTemporaryLock({
    root: ROOT,
    args,
  });
}

async function generate(
  contract: string,
  guest: string,
  out: string,
  ...args: string[]
) {
  return await runDeno((lockPath) => [
    "run",
    "--allow-all",
    "--frozen=true",
    "--lock",
    lockPath,
    SCRIPT,
    "--contract",
    contract,
    "--guest",
    guest,
    "--out",
    out,
    ...args,
  ]);
}

const contractPrefix = `
export interface IframeInputData { heading: string }
export interface IframeStateData { count: number }
export interface IframeOutputData { count: number }
export const DEFAULT_INPUT: IframeInputData = { heading: "Test" };
export const DEFAULT_STATE: IframeStateData = { count: 0 };
export const DEFAULT_OUTPUT: IframeOutputData = { count: 0 };
`;

describe("iframe pattern wrapper generator", () => {
  it("keeps state and output scoped to the active viewer", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-scopes-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const out = resolve(directory, "main.tsx");
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
export const IFRAME_PATTERN = {
  name: "ScopedState",
  stateScope: "user",
  outputScope: "session",
} as const;
`,
      );
      await Deno.writeTextFile(guest, "document.body.textContent = 'guest';\n");

      const result = await generate(contract, guest, out);
      expect(result.code, decoder.decode(result.stderr)).toBe(0);
      const generated = await Deno.readTextFile(out);
      expect(generated).toContain(
        "state?: PerUser<Writable<IframeStateData | Default<typeof DEFAULT_STATE>>>;",
      );
      expect(generated).toContain(
        "output?: PerSession<Writable<IframeOutputData | Default<typeof DEFAULT_OUTPUT>>>;",
      );
      expect(generated).toMatch(
        /\(\(\{\s*input,\s*state,\s*output,\s*\}\) => \{/,
      );
      expect(generated).not.toContain("new Writable.perUser");
      expect(generated).not.toContain("new Writable.perSession");
    } finally {
      await removeDirectory(directory);
    }
  });

  it("hides embedded guest tokens from the host module scanner", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-module-string-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const html = resolve(directory, "guest.html");
      const out = resolve(directory, "main.tsx");
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
export const IFRAME_PATTERN = { name: "ModuleString" } as const;
`,
      );
      await Deno.writeTextFile(
        guest,
        `document.body.dataset.syntax = "import(";\n`,
      );
      await Deno.writeTextFile(
        html,
        "<!doctype html><body><!-- guest --><!-- PATTERN_IFRAME_SCRIPT --></body>",
      );

      const result = await generate(contract, guest, out, "--html", html);
      expect(result.code, decoder.decode(result.stderr)).toBe(0);
      const generated = await Deno.readTextFile(out);
      const moduleString = generated.match(/^const GUEST_HTML = (.*);$/m)?.[1];
      expect(moduleString).toBeDefined();
      expect(moduleString).not.toContain("import");
      expect(moduleString).not.toContain("<!--");
      expect(moduleString).not.toContain("-->");
      expect(moduleString).toContain("\\u0069mport");
      expect(moduleString).toContain("\\u003c!--");
      expect(moduleString).toContain("--\\u003e");
    } finally {
      await removeDirectory(directory);
    }
  });

  it("replaces a forced output symlink without overwriting its source", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-symlink-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const out = resolve(directory, "main.tsx");
      const guestSource = 'document.body.textContent = "guest";\n';
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
export const IFRAME_PATTERN = { name: "SymlinkSafe" } as const;
`,
      );
      await Deno.writeTextFile(guest, guestSource);
      await Deno.symlink("guest.ts", out);

      const result = await generate(contract, guest, out, "--force");

      expect(result.code).toBe(0);
      expect(await Deno.readTextFile(guest)).toBe(guestSource);
      expect((await Deno.lstat(out)).isSymlink).toBe(false);
      expect(await Deno.readTextFile(out)).toContain(
        "export default pattern<SymlinkSafeInput, SymlinkSafeOutput>",
      );
    } finally {
      await removeDirectory(directory);
    }
  });

  it("replaces a forced output hardlink without overwriting its source", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-hardlink-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const out = resolve(directory, "main.tsx");
      const guestSource = 'document.body.textContent = "guest";\n';
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
export const IFRAME_PATTERN = { name: "HardlinkSafe" } as const;
`,
      );
      await Deno.writeTextFile(guest, guestSource);
      await Deno.link(guest, out);

      const result = await generate(contract, guest, out, "--force");

      expect(result.code).toBe(0);
      expect(await Deno.readTextFile(guest)).toBe(guestSource);
      expect(await Deno.readTextFile(out)).toContain(
        "export default pattern<HardlinkSafeInput, HardlinkSafeOutput>",
      );
      expect((await Deno.stat(guest)).ino).not.toBe((await Deno.stat(out)).ino);
    } finally {
      await removeDirectory(directory);
    }
  });

  it("keeps public SQLite names separate from generated bindings", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "pattern-iframe-names-",
    });
    try {
      const contract = resolve(directory, "contract.ts");
      const guest = resolve(directory, "guest.ts");
      const out = resolve(directory, "main.tsx");
      await Deno.writeTextFile(
        contract,
        `${contractPrefix}
const columns = {
  ["__proto__"]: "text",
  ["constructor"]: "text",
};
export const IFRAME_PATTERN = {
  name: "SafeNames",
  databases: {
    ["class"]: { tables: { ["__proto__"]: columns } },
    ["table"]: { tables: {} },
    ["app"]: { tables: {} },
    ["appTables"]: { tables: {} },
    ["constructor"]: { tables: {} },
    ["__proto__"]: { tables: {} },
  },
} as const;
`,
      );
      await Deno.writeTextFile(guest, "document.body.textContent = 'guest';\n");

      const result = await generate(contract, guest, out);
      expect(result.code).toBe(0);
      const generated = await Deno.readTextFile(out);
      expect(generated).toContain("const iframeDatabase0Tables = {");
      expect(generated).toContain('["__proto__"]: table({');
      expect(generated).toContain('["__proto__"]: "text"');
      expect(generated).toContain('["class"]: iframeDatabase0');
      expect(generated).toContain('["constructor"]: "sqlite"');
      expect(generated).not.toContain("const class");
      expect(generated).not.toContain("const appTables");

      const format = await runDeno(() => ["fmt", out]);
      expect(format.code, decoder.decode(format.stderr)).toBe(0);
    } finally {
      await removeDirectory(directory);
    }
  });
});
