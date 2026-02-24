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
  EACCES,
  EINVAL,
  EIO,
  EISDIR,
  ENODATA,
  ENOENT,
  ENOTDIR,
  ENTRY_PARAM_SIZE,
  ERANGE,
  EXDEV,
  FILE_MODE,
  FILE_MODE_RW,
  FILE_MODE_WO,
  FUSE_SET_ATTR_SIZE,
  O_RDWR,
  O_TRUNC,
  O_WRONLY,
  OPS_OFFSETS,
  OPS_SIZE,
  readCString,
  readFileInfo,
  STAT_SIZE,
  SYMLINK_MODE,
  writeEntryParam,
  writeFileInfo,
  writeStat,
} from "./ffi-types.ts";
import { FsTree } from "./tree.ts";
import { HandleMap } from "./handles.ts";

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

  // File handle tracking for write support
  const handles = new HandleMap();

  function nodeMode(node: ReturnType<typeof tree.getNode>, ino?: bigint) {
    if (!node) return 0;
    if (node.kind === "dir") return DIR_MODE;
    if (node.kind === "symlink") return SYMLINK_MODE;
    if (node.kind === "handler") return FILE_MODE_WO;
    // Files in writable piece data get 644, others stay 444
    if (bridge && ino !== undefined && bridge.resolveWritePath(ino)) {
      return FILE_MODE_RW;
    }
    return FILE_MODE;
  }

  function nodeSize(node: ReturnType<typeof tree.getNode>) {
    if (!node) return 0;
    if (node.kind === "file") return node.content.length;
    if (node.kind === "symlink") return node.target.length;
    if (node.kind === "handler") return 0;
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
        mode: nodeMode(node, ino),
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
        mode: nodeMode(node, inode),
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

  // open(req, ino, fi_ptr) — write-aware
  const openCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      fi: Deno.PointerValue,
    ) => {
      const inode = BigInt(ino);
      const node = tree.getNode(inode);
      if (!node) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }
      if (node.kind === "dir") {
        fuse.symbols.fuse_reply_err(req, EISDIR);
        return;
      }

      // Handler files: write-only, no read
      if (node.kind === "handler") {
        const { flags: hFlags } = readFileInfo(fi);
        const isWriting = (hFlags & O_WRONLY) !== 0 ||
          (hFlags & O_RDWR) !== 0;
        if (!isWriting) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }
        const fh = handles.open(inode, hFlags, new Uint8Array(0));
        writeFileInfo(fi, fh);
        fuse.symbols.fuse_reply_open(req, fi);
        return;
      }

      const { flags } = readFileInfo(fi);
      const isWriting = (flags & O_WRONLY) !== 0 || (flags & O_RDWR) !== 0;

      if (isWriting && bridge) {
        const writePath = bridge.resolveWritePath(inode);
        if (!writePath) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }
      }

      // Get current content for the handle buffer
      const content = node.kind === "file" ? node.content : new Uint8Array(0);
      const truncate = (flags & O_TRUNC) !== 0;
      const fh = handles.open(
        inode,
        flags,
        truncate ? new Uint8Array(0) : content,
      );
      if (truncate) {
        handles.get(fh)!.dirty = true;
      }
      writeFileInfo(fi, fh);
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
      fi: Deno.PointerValue,
    ) => {
      const inode = BigInt(ino);

      // Handler files are write-only
      const handlerNode = tree.getNode(inode);
      if (handlerNode?.kind === "handler") {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      // If we have an open handle with a buffer, read from it
      const { fh } = readFileInfo(fi);
      const handle = handles.get(fh);
      if (handle && handle.buffer.length > 0) {
        const off = Number(offset);
        const sz = Number(size);
        const data = handle.buffer;
        if (off >= data.length) {
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
        return;
      }

      const node = tree.getNode(inode);
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

  /**
   * Process a dirty handle buffer: decode, parse, and write to cell.
   * Returns 0 on success, errno on failure.
   */
  async function flushHandle(
    handle: ReturnType<typeof handles.get>,
  ): Promise<number> {
    if (!handle || !handle.dirty || !bridge) return 0;

    // Handler files: parse JSON and send to stream cell
    const handlerNode = tree.getNode(handle.ino);
    if (handlerNode?.kind === "handler") {
      try {
        const text = new TextDecoder().decode(handle.buffer);
        const value = JSON.parse(text.trim());
        await bridge.sendToHandler(handle.ino, value);
        handle.dirty = false;
        handle.buffer = new Uint8Array(0); // fire-and-forget
        return 0;
      } catch (e) {
        console.error(`[fuse] handler flush error: ${e}`);
        return EIO;
      }
    }

    const writePath = bridge.resolveWritePath(handle.ino);
    if (!writePath) return EACCES;

    try {
      const text = new TextDecoder().decode(handle.buffer);
      let value: unknown;

      if (writePath.isJsonFile) {
        // .json file: parse as JSON
        try {
          value = JSON.parse(text);
        } catch {
          return EINVAL;
        }
      } else {
        // Scalar file: try JSON parse first, then treat as string
        const trimmed = text.replace(/\n$/, "");
        try {
          const parsed = JSON.parse(trimmed);
          // Only accept JSON primitives (number, boolean, null, string)
          if (
            typeof parsed === "number" ||
            typeof parsed === "boolean" ||
            parsed === null ||
            typeof parsed === "string"
          ) {
            value = parsed;
          } else {
            // It's an object/array — treat as string for scalar files
            value = trimmed;
          }
        } catch {
          // Not valid JSON — use as string
          value = trimmed;
        }
      }

      await bridge.writeValue(writePath, value);
      handle.dirty = false;

      // Optimistic tree update: update the file node content immediately
      const node = tree.getNode(handle.ino);
      if (node && node.kind === "file") {
        tree.updateFile(handle.ino, text);
      }

      return 0;
    } catch (e) {
      console.error(`[fuse] flush error: ${e}`);
      return EIO;
    }
  }

  // write(req, ino, buf_ptr, size, offset, fi_ptr)
  const writeCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "u64", "pointer", "usize", "i64", "pointer"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      _ino: number | bigint,
      bufPtr: Deno.PointerValue,
      size: number | bigint,
      offset: number | bigint,
      fi: Deno.PointerValue,
    ) => {
      const { fh } = readFileInfo(fi);
      const handle = handles.get(fh);
      if (!handle) {
        fuse.symbols.fuse_reply_err(req, EIO);
        return;
      }

      const sz = Number(size);
      const off = Number(offset);

      // Read data from the FUSE-provided buffer
      const data = new Uint8Array(sz);
      if (bufPtr) {
        const view = new Deno.UnsafePointerView(bufPtr);
        view.copyInto(data);
      }

      handles.write(fh, data, off);
      fuse.symbols.fuse_reply_write(req, sz);
    },
  );
  callbacks.push(writeCb);

  // flush(req, ino, fi_ptr) — async: processes dirty buffer
  const flushCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      _ino: number | bigint,
      fi: Deno.PointerValue,
    ) => {
      const { fh } = readFileInfo(fi);
      const handle = handles.get(fh);

      if (!handle || !handle.dirty) {
        fuse.symbols.fuse_reply_err(req, 0);
        return;
      }

      // Async flush — FUSE req stays valid until replied
      flushHandle(handle).then((errno) => {
        fuse.symbols.fuse_reply_err(req, errno);
      }).catch((e) => {
        console.error(`[fuse] flush callback error: ${e}`);
        fuse.symbols.fuse_reply_err(req, EIO);
      });
    },
  );
  callbacks.push(flushCb);

  // setattr(req, ino, attr_ptr, to_set, fi_ptr)
  const setattrCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "u64", "pointer", "i32", "pointer"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      ino: number | bigint,
      _attrPtr: Deno.PointerValue,
      toSet: number,
      fi: Deno.PointerValue,
    ) => {
      const inode = BigInt(ino);
      const node = tree.getNode(inode);
      if (!node) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      // Handle truncate (O_TRUNC)
      if (toSet & FUSE_SET_ATTR_SIZE) {
        const { fh } = readFileInfo(fi);
        const handle = handles.get(fh);
        if (handle) {
          // Read the new size from the attr struct
          // st_size is at offset 96 in struct stat
          // For simplicity, we just handle size=0 (truncate)
          handles.truncate(fh, 0);
        } else if (node.kind === "file") {
          // No handle — update tree directly
          tree.updateFile(inode, "");
        }
      }

      // Reply with current attrs (silently accept chmod/chown/times)
      const statBuf = new ArrayBuffer(STAT_SIZE);
      writeStat(statBuf, {
        ino: inode,
        mode: nodeMode(node, inode),
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
  callbacks.push(setattrCb);

  // release(req, ino, fi_ptr) — flush dirty handles before closing
  const releaseCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (req: Deno.PointerValue, _ino: number | bigint, fi: Deno.PointerValue) => {
      const { fh } = readFileInfo(fi);
      const handle = handles.get(fh);

      if (handle && handle.dirty && bridge) {
        // Async flush before release
        flushHandle(handle).then(() => {
          handles.close(fh);
          fuse.symbols.fuse_reply_err(req, 0);
        }).catch((e) => {
          console.error(`[fuse] release flush error: ${e}`);
          handles.close(fh);
          fuse.symbols.fuse_reply_err(req, 0);
        });
        return;
      }

      handles.close(fh);
      fuse.symbols.fuse_reply_err(req, 0);
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

  // create(req, parent_ino, name_ptr, mode, fi_ptr)
  const createCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "u64", "pointer", "u32", "pointer"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      parentIno: number | bigint,
      namePtr: Deno.PointerValue,
      _mode: number,
      fi: Deno.PointerValue,
    ) => {
      if (!bridge) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const parent = BigInt(parentIno);
      const name = readCString(namePtr);
      const parentPath = bridge.resolveWritePath(parent);

      if (!parentPath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      // Write empty string at the new key
      const newPath = [...parentPath.jsonPath, name];
      bridge.writeValue(
        { ...parentPath, jsonPath: newPath },
        "",
      ).then(() => {
        // Create file node in tree
        const ino = tree.addFile(parent, name, "", "string");

        // Allocate handle
        const fh = handles.open(ino, O_RDWR, new Uint8Array(0));
        writeFileInfo(fi, fh);

        // Build entry_param
        const entryBuf = new ArrayBuffer(ENTRY_PARAM_SIZE);
        writeEntryParam(entryBuf, {
          ino,
          attr: {
            ino,
            mode: FILE_MODE_RW,
            nlink: 1,
            size: 0,
          },
          attrTimeout: 1.0,
          entryTimeout: 1.0,
        });

        fuse.symbols.fuse_reply_create(
          req,
          Deno.UnsafePointer.of(new Uint8Array(entryBuf)),
          fi,
        );
      }).catch((e) => {
        console.error(`[fuse] create error: ${e}`);
        fuse.symbols.fuse_reply_err(req, EIO);
      });
    },
  );
  callbacks.push(createCb);

  // mkdir(req, parent_ino, name_ptr, mode)
  const mkdirCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "u64", "pointer", "u32"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      parentIno: number | bigint,
      namePtr: Deno.PointerValue,
      _mode: number,
    ) => {
      if (!bridge) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const parent = BigInt(parentIno);
      const name = readCString(namePtr);
      const parentPath = bridge.resolveWritePath(parent);

      if (!parentPath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      // Write empty object at the new key
      const newPath = [...parentPath.jsonPath, name];
      bridge.writeValue(
        { ...parentPath, jsonPath: newPath },
        {},
      ).then(() => {
        const ino = tree.addDir(parent, name, "object");
        const node = tree.getNode(ino);
        replyEntry(req, ino, node);
      }).catch((e) => {
        console.error(`[fuse] mkdir error: ${e}`);
        fuse.symbols.fuse_reply_err(req, EIO);
      });
    },
  );
  callbacks.push(mkdirCb);

  // unlink(req, parent_ino, name_ptr)
  const unlinkCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      parentIno: number | bigint,
      namePtr: Deno.PointerValue,
    ) => {
      if (!bridge) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const parent = BigInt(parentIno);
      const name = readCString(namePtr);
      const childIno = tree.lookup(parent, name);
      if (childIno === undefined) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      const writePath = bridge.resolveWritePath(childIno);
      if (!writePath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      // For array parents: read parent array, splice, write back
      const parentNode = tree.getNode(parent);
      const isArrayParent = parentNode?.kind === "dir" &&
        parentNode.jsonType === "array";

      const doUnlink = async () => {
        if (isArrayParent) {
          // Array element removal: read parent, splice, write whole array
          const parentPath = bridge!.resolveWritePath(parent);
          if (!parentPath) throw new Error("Parent not writable");
          const currentValue = await writePath.piece[writePath.cell].get(
            parentPath.jsonPath.length > 0 ? parentPath.jsonPath : undefined,
          );
          if (Array.isArray(currentValue)) {
            const idx = Number(name);
            if (!isNaN(idx) && idx >= 0 && idx < currentValue.length) {
              currentValue.splice(idx, 1);
              await bridge!.writeValue(parentPath, currentValue);
            }
          }
        } else {
          // Object key removal: read parent object, delete key, write back
          const parentPath = bridge!.resolveWritePath(parent);
          if (!parentPath) throw new Error("Parent not writable");
          const currentValue = await writePath.piece[writePath.cell].get(
            parentPath.jsonPath.length > 0 ? parentPath.jsonPath : undefined,
          );
          if (
            currentValue && typeof currentValue === "object" &&
            !Array.isArray(currentValue)
          ) {
            const obj = { ...(currentValue as Record<string, unknown>) };
            delete obj[name];
            await bridge!.writeValue(parentPath, obj);
          }
        }
        tree.removeChild(parent, name);
        // Also remove .json sibling if it exists
        if (name.endsWith(".json")) {
          // Removing a .json file — remove the corresponding directory too
          const dirName = name.slice(0, -5);
          const dirIno = tree.lookup(parent, dirName);
          if (dirIno !== undefined) {
            tree.removeChild(parent, dirName);
          }
        } else {
          const jsonIno = tree.lookup(parent, `${name}.json`);
          if (jsonIno !== undefined) {
            tree.removeChild(parent, `${name}.json`);
          }
        }
      };

      doUnlink().then(() => {
        fuse.symbols.fuse_reply_err(req, 0);
      }).catch((e) => {
        console.error(`[fuse] unlink error: ${e}`);
        fuse.symbols.fuse_reply_err(req, EIO);
      });
    },
  );
  callbacks.push(unlinkCb);

  // rmdir(req, parent_ino, name_ptr)
  const rmdirCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (
      req: Deno.PointerValue,
      parentIno: number | bigint,
      namePtr: Deno.PointerValue,
    ) => {
      if (!bridge) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const parent = BigInt(parentIno);
      const name = readCString(namePtr);
      const childIno = tree.lookup(parent, name);
      if (childIno === undefined) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      const childNode = tree.getNode(childIno);
      if (!childNode || childNode.kind !== "dir") {
        fuse.symbols.fuse_reply_err(req, ENOTDIR);
        return;
      }

      const writePath = bridge.resolveWritePath(childIno);
      if (!writePath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      // Same removal logic as unlink but for a directory
      const parentNode = tree.getNode(parent);
      const isArrayParent = parentNode?.kind === "dir" &&
        parentNode.jsonType === "array";

      const doRmdir = async () => {
        if (isArrayParent) {
          const parentPath = bridge!.resolveWritePath(parent);
          if (!parentPath) throw new Error("Parent not writable");
          const currentValue = await writePath.piece[writePath.cell].get(
            parentPath.jsonPath.length > 0 ? parentPath.jsonPath : undefined,
          );
          if (Array.isArray(currentValue)) {
            const idx = Number(name);
            if (!isNaN(idx) && idx >= 0 && idx < currentValue.length) {
              currentValue.splice(idx, 1);
              await bridge!.writeValue(parentPath, currentValue);
            }
          }
        } else {
          const parentPath = bridge!.resolveWritePath(parent);
          if (!parentPath) throw new Error("Parent not writable");
          const currentValue = await writePath.piece[writePath.cell].get(
            parentPath.jsonPath.length > 0 ? parentPath.jsonPath : undefined,
          );
          if (
            currentValue && typeof currentValue === "object" &&
            !Array.isArray(currentValue)
          ) {
            const obj = { ...(currentValue as Record<string, unknown>) };
            delete obj[name];
            await bridge!.writeValue(parentPath, obj);
          }
        }
        tree.removeChild(parent, name);
        // Also remove .json sibling
        const jsonIno = tree.lookup(parent, `${name}.json`);
        if (jsonIno !== undefined) {
          tree.removeChild(parent, `${name}.json`);
        }
      };

      doRmdir().then(() => {
        fuse.symbols.fuse_reply_err(req, 0);
      }).catch((e) => {
        console.error(`[fuse] rmdir error: ${e}`);
        fuse.symbols.fuse_reply_err(req, EIO);
      });
    },
  );
  callbacks.push(rmdirCb);

  // rename(req, parent_ino, name_ptr, newparent_ino, newname_ptr)
  const renameCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "u64", "pointer", "u64", "pointer"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      parentIno: number | bigint,
      namePtr: Deno.PointerValue,
      newParentIno: number | bigint,
      newNamePtr: Deno.PointerValue,
    ) => {
      if (!bridge) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const oldParent = BigInt(parentIno);
      const oldName = readCString(namePtr);
      const newParent = BigInt(newParentIno);
      const newName = readCString(newNamePtr);

      const childIno = tree.lookup(oldParent, oldName);
      if (childIno === undefined) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      const oldWritePath = bridge.resolveWritePath(childIno);
      if (!oldWritePath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      // Check new parent is in the same cell
      const newParentPath = bridge.resolveWritePath(newParent);
      if (!newParentPath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      if (
        oldWritePath.spaceName !== newParentPath.spaceName ||
        oldWritePath.pieceName !== newParentPath.pieceName ||
        oldWritePath.cell !== newParentPath.cell
      ) {
        fuse.symbols.fuse_reply_err(req, EXDEV);
        return;
      }

      const doRename = async () => {
        // Read value at old path
        const value = await oldWritePath.piece[oldWritePath.cell].get(
          oldWritePath.jsonPath.length > 0 ? oldWritePath.jsonPath : undefined,
        );

        // Write at new path
        const destPath = [...newParentPath.jsonPath, newName];
        await bridge!.writeValue(
          { ...newParentPath, jsonPath: destPath },
          value,
        );

        // Delete old path: read parent, delete key, write back
        const oldParentWritePath = bridge!.resolveWritePath(oldParent);
        if (oldParentWritePath) {
          const parentValue = await oldWritePath.piece[oldWritePath.cell].get(
            oldParentWritePath.jsonPath.length > 0
              ? oldParentWritePath.jsonPath
              : undefined,
          );
          if (
            parentValue && typeof parentValue === "object" &&
            !Array.isArray(parentValue)
          ) {
            const obj = { ...(parentValue as Record<string, unknown>) };
            delete obj[oldName];
            await bridge!.writeValue(oldParentWritePath, obj);
          } else if (Array.isArray(parentValue)) {
            const idx = Number(oldName);
            if (!isNaN(idx)) {
              parentValue.splice(idx, 1);
              await bridge!.writeValue(oldParentWritePath, parentValue);
            }
          }
        }

        // Update tree
        tree.rename(oldParent, oldName, newParent, newName);
      };

      doRename().then(() => {
        fuse.symbols.fuse_reply_err(req, 0);
      }).catch((e) => {
        console.error(`[fuse] rename error: ${e}`);
        fuse.symbols.fuse_reply_err(req, EIO);
      });
    },
  );
  callbacks.push(renameCb);

  // symlink(req, target_ptr, parent_ino, name_ptr)
  const symlinkCb = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "pointer", "u64", "pointer"],
      result: "void",
    } as const,
    (
      req: Deno.PointerValue,
      targetPtr: Deno.PointerValue,
      parentIno: number | bigint,
      namePtr: Deno.PointerValue,
    ) => {
      if (!bridge) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const target = readCString(targetPtr);
      const name = readCString(namePtr);
      const parent = BigInt(parentIno);

      // Check parent is writable
      const parentPath = bridge.resolveWritePath(parent);
      if (!parentPath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      // Parse target into sigil link components
      const sigil = bridge.parseSymlinkTarget(parent, target);
      if (!sigil) {
        fuse.symbols.fuse_reply_err(req, EINVAL);
        return;
      }

      // Construct sigil link value and write to cell
      const sigilValue = { "/": { "link@1": sigil } };
      const writePath = {
        ...parentPath,
        jsonPath: [...parentPath.jsonPath, name],
      };

      bridge.writeValue(writePath, sigilValue).then(() => {
        // Add symlink to tree
        const ino = tree.addSymlink(parent, name, target);
        const node = tree.getNode(ino);
        replyEntry(req, ino, node);
      }).catch((e) => {
        console.error(`[fuse] symlink error: ${e}`);
        fuse.symbols.fuse_reply_err(req, EIO);
      });
    },
  );
  callbacks.push(symlinkCb);

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
  setOp(OPS_OFFSETS.setattr, setattrCb);
  setOp(OPS_OFFSETS.readlink, readlinkCb);
  setOp(OPS_OFFSETS.symlink, symlinkCb);
  setOp(OPS_OFFSETS.mkdir, mkdirCb);
  setOp(OPS_OFFSETS.unlink, unlinkCb);
  setOp(OPS_OFFSETS.rmdir, rmdirCb);
  setOp(OPS_OFFSETS.rename, renameCb);
  setOp(OPS_OFFSETS.open, openCb);
  setOp(OPS_OFFSETS.read, readFileCb);
  setOp(OPS_OFFSETS.write, writeCb);
  setOp(OPS_OFFSETS.flush, flushCb);
  setOp(OPS_OFFSETS.release, releaseCb);
  setOp(OPS_OFFSETS.opendir, opendirCb);
  setOp(OPS_OFFSETS.readdir, readdirCb);
  setOp(OPS_OFFSETS.releasedir, releasedirCb);
  setOp(OPS_OFFSETS.getxattr, getxattrCb);
  setOp(OPS_OFFSETS.listxattr, listxattrCb);
  setOp(OPS_OFFSETS.create, createCb);

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
