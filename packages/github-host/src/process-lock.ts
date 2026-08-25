import { dirname, join, resolve } from "@std/path";

const heldPaths = new Set<string>();

function validatePrivateFile(info: Deno.FileInfo, path: string): void {
  if (info.isSymlink || !info.isFile) {
    throw new Error(`GitHub host process lock is not a regular file: ${path}`);
  }
  if (Deno.build.os === "windows") return;
  if (info.uid !== null && info.uid !== Deno.uid()) {
    throw new Error(`GitHub host process lock has a different owner: ${path}`);
  }
  if (info.mode !== null && (info.mode & 0o077) !== 0) {
    throw new Error(
      `GitHub host process lock is accessible by other users: ${path}`,
    );
  }
}

async function openLockFile(path: string): Promise<Deno.FsFile> {
  try {
    const info = await Deno.lstat(path);
    validatePrivateFile(info, path);
    return await Deno.open(path, { read: true, write: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return await Deno.open(path, {
      createNew: true,
      read: true,
      write: true,
      mode: 0o600,
    });
  }
}

/** Return the private default directory for GitHub host process locks. */
export function defaultGithubHostLockDirectory(
  readEnv: (key: string) => string | undefined = (key) => Deno.env.get(key),
): string {
  const configured = readEnv("CF_GITHUB_HOST_LOCK_DIR")?.trim();
  if (configured) return resolve(configured);
  const temporaryDirectory = readEnv("TMPDIR")?.trim() || "/tmp";
  return join(
    resolve(temporaryDirectory),
    `commonfabric-github-host-${Deno.uid()}`,
  );
}

/** Return a deterministic process-lock path for one Fabric destination. */
export async function githubTargetProcessLockPath(
  apiUrl: string,
  spaceDid: string,
  source: string,
  directory = defaultGithubHostLockDirectory(),
): Promise<string> {
  const endpoint = new URL(apiUrl);
  endpoint.username = "";
  endpoint.password = "";
  endpoint.hash = "";
  endpoint.search = "";
  endpoint.pathname = "/";
  const bytes = new TextEncoder().encode(
    `${endpoint.href}\n${spaceDid}\n${source.toLowerCase()}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const key = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return join(resolve(directory), `target-${key}.lock`);
}

/** An exclusive process lock for one GitHub connector destination. */
export class GithubHostProcessLock {
  readonly #file: Deno.FsFile;
  readonly #path: string;
  #released = false;

  private constructor(file: Deno.FsFile, path: string) {
    this.#file = file;
    this.#path = path;
  }

  /** Acquire an exclusive lock or reject when another host owns it. */
  static async acquire(path: string): Promise<GithubHostProcessLock> {
    const normalizedPath = resolve(path);
    if (heldPaths.has(normalizedPath)) {
      throw new Error(`another GitHub host holds the process lock: ${path}`);
    }
    heldPaths.add(normalizedPath);
    let file: Deno.FsFile | undefined;
    try {
      await Deno.mkdir(dirname(normalizedPath), {
        recursive: true,
        mode: 0o700,
      });
      file = await openLockFile(normalizedPath);
      validatePrivateFile(await file.stat(), normalizedPath);
      if (!(await file.tryLock(true))) {
        throw new Error(
          `another GitHub host holds the process lock: ${normalizedPath}`,
        );
      }
      await file.truncate(0);
      await file.write(new TextEncoder().encode(`${Deno.pid}\n`));
      await file.syncData();
      return new GithubHostProcessLock(file, normalizedPath);
    } catch (error) {
      file?.close();
      heldPaths.delete(normalizedPath);
      throw error;
    }
  }

  /** Release the lock and close its file descriptor. */
  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    try {
      await this.#file.unlock();
    } finally {
      this.#file.close();
      heldPaths.delete(this.#path);
    }
  }
}
