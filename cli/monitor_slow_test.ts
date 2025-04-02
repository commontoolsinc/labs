#!/usr/bin/env -S deno run --allow-run --allow-env --allow-read --allow-write

const CSV_FILE = "slow_test_results.csv";

async function ensureCsvExists() {
  try {
    await Deno.stat(CSV_FILE);
  } catch {
    // File doesn't exist, create it with headers
    await Deno.writeTextFile(
      CSV_FILE,
      "start_time,duration_seconds,status\n",
    );
  }
}

async function logToCsv(startTime: number, duration: number, status: string) {
  await Deno.writeTextFile(
    CSV_FILE,
    `${new Date(startTime).toISOString()},${duration},${status}\n`,
    { append: true },
  );
}

async function runCommand() {
  const startTime = Date.now();
  console.log(`Starting Command at ${new Date(startTime).toISOString()}`);

  const command = new Deno.Command("deno", {
    args: [
      "task",
      "slow",
      "--name",
      "slow-test",
      "--charmId",
      "baedreihenfvbku4fw2wemt762d5qtk4f6pie4mcupthm2k6b2jkuy43b54",
    ],
  });

  const process = command.spawn();

  // Wait for up to 60 seconds
  for (let i = 0; i < 60; i++) {
    try {
      const status = await process.status;
      if (status.success) {
        const endTime = Date.now();
        const duration = (endTime - startTime) / 1000;
        console.log(
          `${
            new Date(startTime).toISOString()
          } Command completed in ${duration} seconds`,
        );
        await logToCsv(startTime, duration, "completed");
        return;
      }
    } catch (error) {
      // Process is still running
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // If we get here, the process is still running after 60 seconds
  console.log(
    `${
      new Date(startTime).toISOString()
    } Command took too long, killing process...`,
  );
  process.kill("SIGTERM");
  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;
  console.log(
    `${
      new Date(startTime).toISOString()
    } Command was killed after ${duration} seconds`,
  );
  await logToCsv(startTime, duration, "killed");
}

// Main loop
async function main() {
  await ensureCsvExists();

  while (true) {
    console.log(`Starting new iteration at ${new Date().toISOString()}`);
    await runCommand();

    // Calculate sleep time to ensure we run exactly every minute
    const currentTime = Date.now();
    const nextRun = currentTime - (currentTime % 60000) + 60000;
    const sleepTime = nextRun - currentTime;
    console.log(`Sleeping for ${sleepTime / 1000} seconds until next run`);
    await new Promise((resolve) => setTimeout(resolve, sleepTime));
  }
}

main().catch(console.error);
