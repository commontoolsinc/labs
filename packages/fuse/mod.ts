// mod.ts — FUSE filesystem entry point
//
// Usage:
//   deno run --unstable-ffi --allow-ffi --allow-read --allow-write --allow-env --allow-net \
//     packages/fuse/mod.ts /tmp/ct-fuse [--api-url URL --space NAME --identity PATH]
//
// Supports multiple spaces. --space can be repeated or omitted (defaults to "home").
// Unknown space names are resolved on-demand via lookup.

import { parseArgs } from "@std/cli/parse-args";
import { openFuse } from "./ffi.ts";
import {
  createFuseArgs,
  DIR_MODE,
  EISDIR,
  ENODATA,
  ENOENT,
  ENTRY_PARAM_SIZE,
  ERANGE,
  FILE_MODE,
  OPS_OFFSETS,
  OPS_SIZE,
  readCString,
  STAT_SIZE,
  SYMLINK_MODE,
  writeEntryParam,
  writeStat,
} from "./ffi-types.ts";
import { FsTree } from "./tree.ts";

const encoder = new TextEncoder();

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["api-url", "space", "identity"],
    collect: ["space"],
    default: {
      "api-url": "",
      space: [] as string[],
      identity: "",
    },
  });

  const mountpoint = args._[0] as string;
  if (!mountpoint) {
    console.error(
      "Usage: mod.ts <mountpoint> [--api-url URL] [--space NAME ...] [--identity PATH]",
    );
    Deno.exit(1);
  }

  // Ensure mountpoint exists
  try {
    Deno.statSync(mountpoint);
  } catch {
    Deno.mkdirSync(mountpoint, { recursive: true });
  }

  // Open libfuse
  const fuse = openFuse();

  // Create filesystem tree
  const tree = new FsTree();

  const { CellBridge } = await import("./cell-bridge.ts");
  // deno-lint-ignore no-explicit-any
  let bridge: InstanceType<typeof CellBridge> | null = null;

  // Populate tree
  const apiUrl = args["api-url"];
  if (apiUrl) {
    const { CellBridge } = await import("./cell-bridge.ts");
    bridge = new CellBridge(tree);
    await bridge.init({
      apiUrl,
      identity: args.identity || "",
    });

    // Connect initial spaces (default: "home")
    const spaces = (args.space as string[]).length > 0
      ? (args.space as string[])
      : ["home"];
    for (const spaceName of spaces) {
      await bridge.connectSpace(spaceName);
      console.log(`Connected space: ${spaceName}`);
    }
  } else {
    tree.addFile(tree.rootIno, "hello.txt", "Hello from FUSE!\n", "string");
    console.log("Static mode: hello.txt");
  }

  // --- Callbacks ---
  // Keep references so GC doesn't collect them.
  // deno-lint-ignore no-explicit-any
  const callbacks: Deno.UnsafeCallback<any>[] = [];

  function nodeMode(node: ReturnType<typeof tree.getNode>) {
    if (!node) return 0;
    return node.kind === "dir"
      ? DIR_MODE
      : node.kind === "symlink"
      ? SYMLINK_MODE
      : FILE_MODE;
  }

  function nodeSize(node: ReturnType<typeof tree.getNode>) {
    if (!node) return 0;
    if (node.kind === "file") return node.content.length;
    if (node.kind === "symlink") return node.target.length;
    return 0;
  }

  function replyEntry(
    req: Deno.PointerValue,
    ino: bigint,
    node: ReturnType<typeof tree.getNode>,
  ) {
    const entryBuf = new ArrayBuffer(ENTRY_PARAM_SIZE);
    writeEntryParam(entryBuf, {
      ino,
      attr: {
        ino,
        mode: nodeMode(node),
        nlink: node!.kind === "dir" ? 2 : 1,
        size: nodeSize(node),
      },
      attrTimeout: 1.0,
      entryTimeout: 1.0,
    });
    fuse.symbols.fuse_reply_entry(
      req,
      Deno.UnsafePointer.of(new Uint8Array(entryBuf)),
    );
  }

  // lookup(req, parent_ino, name_ptr)
  // This callback supports async space connection: if a name at root isn't found,
  // we attempt connectSpace() before replying.
  const lookupCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      parentIno: number | bigint,
      namePtr: Deno.PointerValue,
    ) => {
      const name = readCString(namePtr);
      const parent = BigInt(parentIno);
      const ino = tree.lookup(parent, name);

      if (ino !== undefined) {
        const node = tree.getNode(ino);
        if (node) {
          replyEntry(req, ino, node);
          return;
        }
      }

      // If at root and bridge is available, try async space connection
      if (parent === tree.rootIno && bridge && !name.startsWith(".")) {
        // Fire off async connection — FUSE req stays valid until replied
        bridge.connectSpace(name).then(() => {
          const newIno = tree.lookup(parent, name);
          if (newIno !== undefined) {
            const newNode = tree.getNode(newIno);
            if (newNode) {
              replyEntry(req, newIno, newNode);
              return;
            }
          }
          fuse.symbols.fuse_reply_err(req, ENOENT);
        }).catch(() => {
          fuse.symbols.fuse_reply_err(req, ENOENT);
        });
        return;
      }

      fuse.symbols.fuse_reply_err(req, ENOENT);
    },
  );
  callbacks.push(lookupCb);

  // forget(req, ino, nlookup) — required to avoid kernel complaints
  const forgetCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "u64"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      _ino: number | bigint,
      _nlookup: number | bigint,
    ) => {
      fuse.symbols.fuse_reply_none(req);
    },
  );
  callbacks.push(forgetCb);

  // getattr(req, ino, fi_ptr)
  const getattrCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (req: Deno.PointerValue, ino: number | bigint, _fi: Deno.PointerValue) => {
      const inode = BigInt(ino);
      const node = tree.getNode(inode);

      if (!node) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      const statBuf = new ArrayBuffer(STAT_SIZE);
      writeStat(statBuf, {
        ino: inode,
        mode: nodeMode(node),
        nlink: node.kind === "dir" ? 2 : 1,
        size: nodeSize(node),
      });

      fuse.symbols.fuse_reply_attr(
        req,
        Deno.UnsafePointer.of(new Uint8Array(statBuf)),
        1.0,
      );
    },
  );
  callbacks.push(getattrCb);

  // readlink(req, ino)
  const readlinkCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64"], result: "void" } as const,
    (req: Deno.PointerValue, ino: number | bigint) => {
      const node = tree.getNode(BigInt(ino));
      if (!node || node.kind !== "symlink") {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }
      fuse.symbols.fuse_reply_readlink(
        req,
        encoder.encode(node.target + "\0"),
      );
    },
  );
  callbacks.push(readlinkCb);

  // open(req, ino, fi_ptr)
  const openCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      fi: Deno.PointerValue,
    ) => {
      const node = tree.getNode(BigInt(ino));
      if (!node) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }
      if (node.kind === "dir") {
        fuse.symbols.fuse_reply_err(req, EISDIR);
        return;
      }
      fuse.symbols.fuse_reply_open(req, fi);
    },
  );
  callbacks.push(openCb);

  // read(req, ino, size, offset, fi_ptr)
  const readFileCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "u64", "usize", "i64", "pointer"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      size: number | bigint,
      offset: number | bigint,
      _fi: Deno.PointerValue,
    ) => {
      const node = tree.getNode(BigInt(ino));
      if (!node || node.kind !== "file") {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      const off = Number(offset);
      const sz = Number(size);
      const data = node.content;

      if (off >= data.length) {
        // EOF — empty reply
        fuse.symbols.fuse_reply_buf(req, null, 0n);
        return;
      }

      const end = Math.min(off + sz, data.length);
      const slice = new Uint8Array(end - off);
      slice.set(data.subarray(off, end));
      fuse.symbols.fuse_reply_buf(
        req,
        Deno.UnsafePointer.of(slice),
        BigInt(slice.length),
      );
    },
  );
  callbacks.push(readFileCb);

  // opendir(req, ino, fi_ptr)
  const opendirCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      fi: Deno.PointerValue,
    ) => {
      const node = tree.getNode(BigInt(ino));
      if (!node || node.kind !== "dir") {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }
      fuse.symbols.fuse_reply_open(req, fi);
    },
  );
  callbacks.push(opendirCb);

  // readdir(req, ino, size, offset, fi_ptr)
  const readdirCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "u64", "usize", "i64", "pointer"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      size: number | bigint,
      offset: number | bigint,
      _fi: Deno.PointerValue,
    ) => {
      const inode = BigInt(ino);
      const node = tree.getNode(inode);
      if (!node || node.kind !== "dir") {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      const bufSize = Number(size);
      const startOffset = Number(offset);

      // Build entry list: ".", "..", then children
      type DirEntry = { name: string; ino: bigint; mode: number };
      const entries: DirEntry[] = [
        { name: ".", ino: inode, mode: DIR_MODE },
        {
          name: "..",
          ino: tree.parents.get(inode) ?? 1n,
          mode: DIR_MODE,
        },
      ];

      for (const [childName, childIno] of tree.getChildren(inode)) {
        const childNode = tree.getNode(childIno);
        if (!childNode) continue;
        entries.push({
          name: childName,
          ino: childIno,
          mode: nodeMode(childNode),
        });
      }

      // Fill buffer starting from startOffset
      const buf = new Uint8Array(bufSize);
      let pos = 0;

      for (let i = startOffset; i < entries.length; i++) {
        const entry = entries[i];
        const nameBuf = encoder.encode(entry.name + "\0");
        const statBuf = new ArrayBuffer(STAT_SIZE);
        writeStat(statBuf, {
          ino: entry.ino,
          mode: entry.mode,
          nlink: 1,
          size: 0,
        });

        const remaining = bufSize - pos;
        const entrySize = fuse.symbols.fuse_add_direntry(
          req,
          Deno.UnsafePointer.of(buf.subarray(pos)),
          BigInt(remaining),
          nameBuf,
          Deno.UnsafePointer.of(new Uint8Array(statBuf)),
          BigInt(i + 1), // next offset
        );

        if (Number(entrySize) > remaining) break;
        pos += Number(entrySize);
      }

      fuse.symbols.fuse_reply_buf(
        req,
        Deno.UnsafePointer.of(buf),
        BigInt(pos),
      );
    },
  );
  callbacks.push(readdirCb);

  // release(req, ino, fi_ptr)
  const releaseCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (req: Deno.PointerValue, _ino: number | bigint, _fi: Deno.PointerValue) => {
      fuse.symbols.fuse_reply_err(req, 0); // success
    },
  );
  callbacks.push(releaseCb);

  // releasedir(req, ino, fi_ptr)
  const releasedirCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (req: Deno.PointerValue, _ino: number | bigint, _fi: Deno.PointerValue) => {
      fuse.symbols.fuse_reply_err(req, 0); // success
    },
  );
  callbacks.push(releasedirCb);

  // getxattr(req, ino, name_ptr, size, position)
  // macOS FUSE has an extra `position` parameter (uint32_t) — always ignored for user attrs
  const getxattrCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "u64", "pointer", "usize", "u32"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      namePtr: Deno.PointerValue,
      size: number | bigint,
      _position: number,
    ) => {
      const attrName = readCString(namePtr);
      const node = tree.getNode(BigInt(ino));

      // Determine the xattr value (if any)
      let attrValue: Uint8Array | null = null;
      if (attrName === "user.json.type" && node) {
        const jsonType = node.kind === "file"
          ? node.jsonType
          : node.kind === "dir"
          ? node.jsonType
          : undefined;
        if (jsonType) {
          attrValue = encoder.encode(jsonType);
        }
      }

      if (!attrValue) {
        fuse.symbols.fuse_reply_err(req, ENODATA);
        return;
      }

      const sz = Number(size);
      if (sz === 0) {
        // Size query: return the value length
        fuse.symbols.fuse_reply_xattr(req, BigInt(attrValue.length));
      } else if (sz >= attrValue.length) {
        // Return the value
        const valBuf = new Uint8Array(attrValue.length);
        valBuf.set(attrValue);
        fuse.symbols.fuse_reply_buf(
          req,
          Deno.UnsafePointer.of(valBuf),
          BigInt(valBuf.length),
        );
      } else {
        // Buffer too small
        fuse.symbols.fuse_reply_err(req, ERANGE);
      }
    },
  );
  callbacks.push(getxattrCb);

  // listxattr(req, ino, size)
  const listxattrCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "usize"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      size: number | bigint,
    ) => {
      const node = tree.getNode(BigInt(ino));

      // Build null-separated list of xattr names
      const jsonType = node?.kind === "file"
        ? node.jsonType
        : node?.kind === "dir"
        ? node.jsonType
        : undefined;

      if (!jsonType) {
        // No xattrs — empty list
        const sz = Number(size);
        if (sz === 0) {
          fuse.symbols.fuse_reply_xattr(req, 0n);
        } else {
          fuse.symbols.fuse_reply_buf(req, null, 0n);
        }
        return;
      }

      // "user.json.type\0"
      const listBuf = encoder.encode("user.json.type\0");
      const sz = Number(size);

      if (sz === 0) {
        fuse.symbols.fuse_reply_xattr(req, BigInt(listBuf.length));
      } else if (sz >= listBuf.length) {
        fuse.symbols.fuse_reply_buf(
          req,
          Deno.UnsafePointer.of(listBuf),
          BigInt(listBuf.length),
        );
      } else {
        fuse.symbols.fuse_reply_err(req, ERANGE);
      }
    },
  );
  callbacks.push(listxattrCb);

  // --- Build ops struct ---
  const opsBuf = new ArrayBuffer(OPS_SIZE);
  const opsView = new DataView(opsBuf);

  // deno-lint-ignore no-explicit-any
  function setOp(offset: number, cb: Deno.UnsafeCallback<any>) {
    opsView.setBigUint64(
      offset,
      BigInt(Deno.UnsafePointer.value(cb.pointer)),
      true,
    );
  }

  setOp(OPS_OFFSETS.lookup, lookupCb);
  setOp(OPS_OFFSETS.forget, forgetCb);
  setOp(OPS_OFFSETS.getattr, getattrCb);
  setOp(OPS_OFFSETS.readlink, readlinkCb);
  setOp(OPS_OFFSETS.open, openCb);
  setOp(OPS_OFFSETS.read, readFileCb);
  setOp(OPS_OFFSETS.opendir, opendirCb);
  setOp(OPS_OFFSETS.readdir, readdirCb);
  setOp(OPS_OFFSETS.release, releaseCb);
  setOp(OPS_OFFSETS.releasedir, releasedirCb);
  setOp(OPS_OFFSETS.getxattr, getxattrCb);
  setOp(OPS_OFFSETS.listxattr, listxattrCb);

  // --- Mount ---
  const { argsBuf, argv: _argv, encodedArgs: _ea } = createFuseArgs([
    "fuse_ct",
  ]);

  const mountpointBuf = encoder.encode(mountpoint + "\0");

  const chan = fuse.symbols.fuse_mount(
    mountpointBuf,
    Deno.UnsafePointer.of(new Uint8Array(argsBuf)),
  );

  if (!chan) {
    console.error(
      "fuse_mount failed. Is the mountpoint valid? Is macFUSE installed?",
    );
    Deno.exit(1);
  }

  const session = fuse.symbols.fuse_lowlevel_new(
    Deno.UnsafePointer.of(new Uint8Array(argsBuf)),
    Deno.UnsafePointer.of(new Uint8Array(opsBuf)),
    BigInt(OPS_SIZE),
    null,
  );

  if (!session) {
    console.error("fuse_lowlevel_new failed");
    fuse.symbols.fuse_unmount(mountpointBuf, chan);
    Deno.exit(1);
  }

  fuse.symbols.fuse_session_add_chan(session, chan);

  let unmounting = false;

  // Wire up kernel cache invalidation for subscriptions
  if (bridge) {
    let notifySupported = true;
    bridge.onInvalidate = (parentIno: bigint, names: string[]) => {
      if (!notifySupported || unmounting) return;
      for (const name of names) {
        const nameBuf = encoder.encode(name + "\0");
        const rc = fuse.symbols.fuse_lowlevel_notify_inval_entry(
          chan,
          parentIno,
          nameBuf,
          BigInt(name.length),
        );
        if (rc === -38) {
          // ENOSYS — FUSE-T doesn't support notify_inval_entry
          console.log(
            "notify_inval_entry not supported (FUSE-T); relying on short timeouts",
          );
          notifySupported = false;
          break;
        }
      }
    };
  }

  console.log(`Mounted at ${mountpoint}`);
  console.log("Press Ctrl+C to unmount");

  // Cleanup on signal
  function unmount() {
    if (unmounting) return;
    unmounting = true;
    console.log("\nUnmounting...");
    fuse.symbols.fuse_unmount(mountpointBuf, chan);
  }

  Deno.addSignalListener("SIGINT", () => {
    unmount();
  });
  Deno.addSignalListener("SIGTERM", () => {
    unmount();
  });

  // Run FUSE event loop (nonblocking: true → returns Promise)
  const result = await fuse.symbols.fuse_session_loop(session);
  console.log(`FUSE loop exited (code ${result})`);

  // Final cleanup
  fuse.symbols.fuse_session_remove_chan(chan);
  fuse.symbols.fuse_session_destroy(session);
  if (!unmounting) {
    fuse.symbols.fuse_unmount(mountpointBuf, chan);
  }
  for (const cb of callbacks) cb.close();
  console.log("Cleaned up.");
}

main();
