import {
  backgroundLogFile,
  classifyLaunch,
  logUncaughtErrors,
  redirectConsoleToFile,
  runBackgroundParent,
  writeListeningMarker,
} from "@/background.ts";

// Thin launcher for the toolshed. This module decides which half of a launch
// the process is and imports the heavy server graph only on the path that
// actually serves. @/server.ts runs startup side effects at import time —
// opening the memory-store provider and fetching the gateway model list — so a
// `--background` parent, which only spawns the real server as a child and waits
// for it to bind, must not import it. The app graph is pulled in through a
// dynamic import on the serving path alone, so index.ts itself stays thin: it
// imports only @/background.ts, which pulls in nothing heavy.

if (import.meta.main) {
  const backgroundLog = backgroundLogFile();
  const launch = classifyLaunch(Deno.args);
  if (launch.background && !backgroundLog) {
    // This process is the background parent: spawn the server as a child and
    // wait for it to bind. The call exits the process once the child is
    // listening (or has failed to start), and never imports the app graph.
    await runBackgroundParent({
      execPath: Deno.execPath(),
      mainModule: import.meta.url,
      serverArgs: launch.serverArgs,
      logFile: launch.logFile,
    });
  } else {
    // This process serves: a foreground launch, or the server half of a
    // background launch. Pull in the server graph now, on the path that uses it.
    const { startServer } = await import("@/server.ts");
    if (backgroundLog) {
      // The server half of a background launch. Its request logger already
      // targets the log file (pino-logger.ts reads the same environment
      // variable); route console output there too, so stdout carries only the
      // readiness marker, and record uncaught errors that would otherwise reach
      // a discarded stderr.
      redirectConsoleToFile(backgroundLog);
      logUncaughtErrors();
      startServer(writeListeningMarker);
    } else {
      startServer();
    }
  }
}
