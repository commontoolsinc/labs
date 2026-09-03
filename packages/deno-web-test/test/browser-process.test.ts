/**
 * How a run's browser is stopped, which is what says when the run's directory
 * can go.
 *
 * The two exports covered here are the ones that can be driven without a
 * browser: a shell process tree stands in for Chrome's, and a shell script
 * stands in for a browser binary that never starts. What a real browser does
 * is covered by the harness runs in `base.test.ts`, `config.test.ts` and
 * `temporary-directories.test.ts`, each of which drives Chrome through
 * `BrowserProcess`.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  BrowserProcess,
  standardErrorClosed,
  stopBrowserProcess,
} from "../browser-process.ts";

// A shell that starts `cat` in the background, says so on its standard output,
// and then waits. `cat` inherits the standard error the shell was spawned with
// and holds it until its own standard input reaches end of file, which the
// test brings about by closing the shell's standard input. The redirection
// through file descriptor 3 is what gets that pipe to `cat`: a background
// job's standard input is /dev/null unless it is redirected explicitly.
const HOLDS_STANDARD_ERROR =
  "exec 3<&0; cat <&3 >/dev/null & echo started; wait";

// A developer-tools endpoint that answers `/json/version` with `protocol` as
// the version it speaks, and the port it listens on. Astral reads that answer
// before it opens a websocket, so a version it does not speak is a connection
// that fails at once rather than one that waits.
function fakeEndpoint(
  protocol: string,
): { server: Deno.HttpServer; port: number } {
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () =>
      Response.json({
        "Protocol-Version": protocol,
        webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/none",
      }),
  );
  return { server, port: (server.addr as Deno.NetAddr).port };
}

// A stand-in for a browser binary: a directory holding a shell script that
// writes `printed` to its standard error and exits with `code`, never naming
// an endpoint, and the launch options that point at it. The caller removes the
// directory.
async function fakeBrowser(printed: string, code: number): Promise<{
  directory: string;
  options: { path: string; args: string[] };
}> {
  const directory = await Deno.makeTempDir({ prefix: "deno-web-test-fake-" });
  const path = `${directory}/browser`;
  await Deno.writeTextFile(
    path,
    `#!/bin/sh\nprintf '%s\\n' '${printed}' >&2\nexit ${code}\n`,
  );
  await Deno.chmod(path, 0o755);
  return {
    directory,
    options: { path, args: [`--user-data-dir=${directory}/profile`] },
  };
}

describe("browser-process", () => {
  describe("stopBrowserProcess()", () => {
    it("ends a running process with `SIGTERM`", async () => {
      const child = new Deno.Command("sh", {
        args: ["-c", "read line"],
        stdin: "piped",
        stdout: "null",
        stderr: "piped",
      }).spawn();

      await stopBrowserProcess(child, standardErrorClosed(child));

      expect((await child.status).signal).toBe("SIGTERM");
      await child.stdin.close();
    });

    it("returns for a process that has already exited, leaving its exit status intact", async () => {
      const child = new Deno.Command("sh", {
        args: ["-c", "exit 0"],
        stdout: "null",
        stderr: "piped",
      }).spawn();
      const closed = standardErrorClosed(child);
      await child.status;

      await stopBrowserProcess(child, closed);

      expect((await child.status).code).toBe(0);
    });

    it("rethrows a kill failure that is not the process having gone", async () => {
      const refused = new Error("Operation not permitted (os error 1)");
      const child = {
        kill: () => {
          throw refused;
        },
        status: Promise.resolve({ success: false, code: 1, signal: null }),
      };

      await expect(stopBrowserProcess(child, Promise.resolve())).rejects
        .toThrow("Operation not permitted");
    });

    it("returns after a process that outlived the one it was given has exited", async () => {
      const child = new Deno.Command("sh", {
        args: ["-c", HOLDS_STANDARD_ERROR],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const closed = standardErrorClosed(child);

      // `cat` is running by the time the shell has said so, so the kill below
      // takes the shell without taking the holder of the pipe with it.
      const stdout = child.stdout.getReader();
      const started = await stdout.read();
      expect(new TextDecoder().decode(started.value)).toBe("started\n");

      // Each of the three events reaches the list from the event loop, so a
      // stop that returned on the shell's exit alone would record itself
      // between the other two rather than after them.
      const events: string[] = [];
      const stopping = stopBrowserProcess(child, closed).then(() => {
        events.push("stopped");
      });
      await child.status;
      events.push("shell exited");
      await child.stdin.close();
      events.push("released");
      await stopping;

      expect(events).toEqual(["shell exited", "released", "stopped"]);
      await stdout.cancel();
    });
  });

  describe("BrowserProcess", () => {
    describe("static members", () => {
      describe("start()", () => {
        it("throws when the browser exits without naming an endpoint", async () => {
          const { directory, options } = await fakeBrowser("no endpoint", 1);

          await expect(BrowserProcess.start(options)).rejects.toThrow(
            "Your binary refused to boot",
          );

          await Deno.remove(directory, { recursive: true });
        });

        it("names the missing dependencies a browser reports", async () => {
          const { directory, options } = await fakeBrowser(
            "error while loading shared libraries: libnss3.so",
            127,
          );

          await expect(BrowserProcess.start(options)).rejects.toThrow(
            "missing system dependencies",
          );

          await Deno.remove(directory, { recursive: true });
        });

        it("stops a browser that starts and then cannot be connected to", async () => {
          const { server, port } = fakeEndpoint("0.0");
          const { directory, options } = await fakeBrowser(
            `DevTools listening on ws://127.0.0.1:${port}/devtools/browser/x`,
            0,
          );

          await expect(BrowserProcess.start(options)).rejects.toThrow(
            "Differing protocol versions",
          );

          await server.shutdown();
          await Deno.remove(directory, { recursive: true });
        });

        it("throws when the launch names no `--user-data-dir`", async () => {
          const { directory, options } = await fakeBrowser("no endpoint", 1);

          await expect(BrowserProcess.start({ ...options, args: [] })).rejects
            .toThrow("--user-data-dir");

          await Deno.remove(directory, { recursive: true });
        });
      });
    });
  });
});
