/**
 * Tests for VFS mount functionality
 */

import { assertEquals, assertThrows } from "@std/assert";
import { VFS } from "../src/vfs.ts";
import { labels } from "../src/labels.ts";

const LABEL_SIDECAR = ".cfc-labels.json";

/** Create a temp dir for mount tests */
async function withTempDir(
  fn: (dir: string) => void | Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "cfc-mount-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("mount: read file from host directory", async () => {
  await withTempDir((dir) => {
    Deno.writeTextFileSync(dir + "/hello.txt", "world");

    const vfs = new VFS();
    const defaultLabel = labels.userInput();
    vfs.mount({ hostPath: dir, mountPoint: "/mnt", defaultLabel });

    const result = vfs.readFileText("/mnt/hello.txt");
    assertEquals(result.value, "world");
    assertEquals(result.label, defaultLabel);
  });
});

Deno.test("mount: write file to host directory", async () => {
  await withTempDir((dir) => {
    const vfs = new VFS();
    const defaultLabel = labels.userInput();
    vfs.mount({ hostPath: dir, mountPoint: "/mnt", defaultLabel });

    vfs.writeFile("/mnt/new.txt", "content", defaultLabel);

    // Verify written to real filesystem
    const hostContent = Deno.readTextFileSync(dir + "/new.txt");
    assertEquals(hostContent, "content");

    // Verify label stored in sidecar
    const sidecar = JSON.parse(
      Deno.readTextFileSync(dir + "/" + LABEL_SIDECAR),
    );
    assertEquals(sidecar["/new.txt"] !== undefined, true);
  });
});

Deno.test("mount: readdir lists host files, hides sidecar", async () => {
  await withTempDir((dir) => {
    Deno.writeTextFileSync(dir + "/a.txt", "a");
    Deno.writeTextFileSync(dir + "/b.txt", "b");
    Deno.writeTextFileSync(dir + "/" + LABEL_SIDECAR, "{}");

    const vfs = new VFS();
    vfs.mount({
      hostPath: dir,
      mountPoint: "/data",
      defaultLabel: labels.bottom(),
    });

    const result = vfs.readdir("/data");
    const sorted = [...result.value].sort();
    assertEquals(sorted, ["a.txt", "b.txt"]);
  });
});

Deno.test("mount: exists works for mounted paths", async () => {
  await withTempDir((dir) => {
    Deno.writeTextFileSync(dir + "/exists.txt", "yes");

    const vfs = new VFS();
    vfs.mount({
      hostPath: dir,
      mountPoint: "/mnt",
      defaultLabel: labels.bottom(),
    });

    assertEquals(vfs.exists("/mnt/exists.txt"), true);
    assertEquals(vfs.exists("/mnt/nope.txt"), false);
  });
});

Deno.test("mount: stat returns host file metadata", async () => {
  await withTempDir((dir) => {
    Deno.writeTextFileSync(dir + "/file.txt", "hello");

    const vfs = new VFS();
    vfs.mount({
      hostPath: dir,
      mountPoint: "/mnt",
      defaultLabel: labels.bottom(),
    });

    const stat = vfs.stat("/mnt/file.txt");
    assertEquals(stat.value.size, 5);
  });
});

Deno.test("mount: read-only mount rejects writes", async () => {
  await withTempDir((dir) => {
    const vfs = new VFS();
    vfs.mount({
      hostPath: dir,
      mountPoint: "/ro",
      defaultLabel: labels.bottom(),
      readOnly: true,
    });

    assertThrows(
      () => vfs.writeFile("/ro/file.txt", "data", labels.bottom()),
      Error,
      "Read-only mount",
    );
  });
});

Deno.test("mount: labels persist across reads", async () => {
  await withTempDir((dir) => {
    Deno.writeTextFileSync(dir + "/tagged.txt", "data");

    const vfs = new VFS();
    const defaultLabel = labels.bottom();
    const customLabel = labels.userInput();
    vfs.mount({ hostPath: dir, mountPoint: "/mnt", defaultLabel });

    // Write with a custom label
    vfs.writeFile("/mnt/tagged.txt", "data", customLabel);

    // Read back — should get the custom label, not the default
    const result = vfs.readFileText("/mnt/tagged.txt");
    assertEquals(result.label, customLabel);
  });
});

Deno.test("mount: unmount removes the mount", async () => {
  await withTempDir((dir) => {
    Deno.writeTextFileSync(dir + "/file.txt", "data");

    const vfs = new VFS();
    vfs.mount({
      hostPath: dir,
      mountPoint: "/mnt",
      defaultLabel: labels.bottom(),
    });
    assertEquals(vfs.exists("/mnt/file.txt"), true);

    vfs.unmount("/mnt");
    assertEquals(vfs.exists("/mnt/file.txt"), false);
  });
});

Deno.test("mount: duplicate mount point throws", async () => {
  await withTempDir((dir) => {
    const vfs = new VFS();
    vfs.mount({
      hostPath: dir,
      mountPoint: "/mnt",
      defaultLabel: labels.bottom(),
    });
    assertThrows(
      () =>
        vfs.mount({
          hostPath: dir,
          mountPoint: "/mnt",
          defaultLabel: labels.bottom(),
        }),
      Error,
      "Already mounted",
    );
  });
});

Deno.test("mount: in-memory VFS still works alongside mounts", async () => {
  await withTempDir((dir) => {
    const vfs = new VFS();
    vfs.mount({
      hostPath: dir,
      mountPoint: "/mnt",
      defaultLabel: labels.bottom(),
    });

    // Write to in-memory VFS path (not mounted)
    vfs.writeFile("/inmemory.txt", "hello", labels.userInput());
    assertEquals(vfs.readFileText("/inmemory.txt").value, "hello");
  });
});

Deno.test("mount: write creates subdirectories on host", async () => {
  await withTempDir((dir) => {
    const vfs = new VFS();
    vfs.mount({
      hostPath: dir,
      mountPoint: "/mnt",
      defaultLabel: labels.bottom(),
    });

    vfs.writeFile("/mnt/sub/dir/file.txt", "nested", labels.bottom());

    const content = Deno.readTextFileSync(dir + "/sub/dir/file.txt");
    assertEquals(content, "nested");
  });
});
