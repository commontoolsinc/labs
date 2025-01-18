import { ensureDir } from "@std/fs";
import { join } from "@std/path";

const LOOKSLIKE_DIR = "../lookslike-high-level";
const DIST_DIR = "./lookslike-highlevel-dist";

async function fixAssetPaths() {
  const indexPath = join(DIST_DIR, "index.html");
  let content = await Deno.readTextFile(indexPath);

  // Fix asset paths
  content = content.replace(
    /src="\/assets\//g,
    'src="/app/latest/assets/',
  );
  content = content.replace(
    /href="\/assets\//g,
    'href="/app/latest/assets/',
  );

  await Deno.writeTextFile(indexPath, content);
  console.log("✅ Fixed asset paths in index.html");
}

async function buildLookslike() {
  try {
    console.log("🏗️ Building lookslike-high-level...");

    // Check if we're in Docker (presence of /.dockerenv)
    const isDocker = await Deno.stat("/.dockerenv").catch(() => false);

    if (!isDocker) {
      // Local development build
      const installProcess = new Deno.Command("npm", {
        args: ["install"],
        cwd: LOOKSLIKE_DIR,
        stdout: "inherit",
        stderr: "inherit",
      });

      const installResult = await installProcess.output();
      if (!installResult.success) {
        throw new Error("npm install failed");
      }

      const buildProcess = new Deno.Command("npm", {
        args: ["run", "build"],
        cwd: LOOKSLIKE_DIR,
        stdout: "inherit",
        stderr: "inherit",
      });

      const buildResult = await buildProcess.output();
      if (!buildResult.success) {
        throw new Error("npm build failed");
      }

      await ensureDir(DIST_DIR);
      const sourceDir = join(LOOKSLIKE_DIR, "dist");
      const copyProcess = new Deno.Command("cp", {
        args: ["-r", `${sourceDir}/.`, DIST_DIR],
        stdout: "inherit",
        stderr: "inherit",
      });

      const copyResult = await copyProcess.output();
      if (!copyResult.success) {
        throw new Error("Failed to copy dist files");
      }
    } else {
      // In Docker, we expect the dist files to be pre-built and copied
      console.log("🐳 Running in Docker - skipping npm build");
      await ensureDir(DIST_DIR);
    }

    await fixAssetPaths();
    console.log("✅ Build completed successfully!");
  } catch (error) {
    console.error("❌ Build failed:", error);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await buildLookslike();
}
