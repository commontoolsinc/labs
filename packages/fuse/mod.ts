// mod.ts — FUSE filesystem entry point
//
// Usage:
//   deno run --unstable-ffi --allow-ffi --allow-read --allow-write --allow-env --allow-net \
//     packages/fuse/mod.ts /tmp/ct-fuse [--api-url URL --space NAME --identity PATH]

import { parseArgs } from "@std/cli/parse-args";
import { openFuse } from "./ffi.ts";
import {
  createFuseArgs,
  DIR_MODE,
  EISDIR,
  ENOENT,
  ENTRY_PARAM_SIZE,
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
    default: {
      "api-url": "",
      space: "",
      identity: "",
    },
  });

  const mountpoint = args._[0] as string;
  if (!mountpoint) {
    console.error(
      "Usage: mod.ts <mountpoint> [--api-url URL --space NAME --identity PATH]",
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

  // Populate tree
  if (args["api-url"] && args.space) {
    const { CellBridge } = await import("./cell-bridge.ts");
    const bridge = new CellBridge(tree);
    await bridge.init({
      apiUrl: args["api-url"],
      space: args.space,
      identity: args.identity || "",
    });
    await bridge.buildSpaceTree(args.space);
    console.log(`Loaded space: ${args.space}`);
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
    return node.kind === "file" ? node.content.length : 0;
  }

  // lookup(req, parent_ino, name_ptr)
  const lookupCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      parentIno: number | bigint,
      namePtr: Deno.PointerValue,
    ) => {
      const name = readCString(namePtr);
      const ino = tree.lookup(BigInt(parentIno), name);

      if (ino === undefined) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      const node = tree.getNode(ino);
      if (!node) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      const entryBuf = new ArrayBuffer(ENTRY_PARAM_SIZE);
      writeEntryParam(entryBuf, {
        ino,
        attr: {
          ino,
          mode: nodeMode(node),
          nlink: node.kind === "dir" ? 2 : 1,
          size: nodeSize(node),
        },
        attrTimeout: 1.0,
        entryTimeout: 1.0,
      });

      fuse.symbols.fuse_reply_entry(
        req,
        Deno.UnsafePointer.of(new Uint8Array(entryBuf)),
      );
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

  console.log(`Mounted at ${mountpoint}`);
  console.log("Press Ctrl+C to unmount");

  // Cleanup on signal
  let unmounting = false;
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
