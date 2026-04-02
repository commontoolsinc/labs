// mod.ts — FUSE filesystem entry point
//
// Usage:
//   deno run --unstable-ffi --allow-ffi --allow-read --allow-write --allow-env --allow-net \
//     packages/fuse/mod.ts /tmp/ct-fuse [--api-url URL --space NAME --identity PATH]
//
// Supports multiple spaces. --space can be repeated or omitted (defaults to "home").
// Unknown space names are resolved on-demand via lookup.

import { parseArgs } from "@std/cli/parse-args";
import {
  CellBridge,
  type HandlerTarget,
  type SourceWritePath,
  type WritePath,
} from "./cell-bridge.ts";
import {
  DIR_MODE,
  EACCES,
  EINVAL,
  EIO,
  EISDIR,
  ENOENT,
  ENOTDIR,
  ERANGE,
  EXDEV,
  FILE_MODE_RW,
  FUSE_SET_ATTR_SIZE,
  getPlatform,
  O_RDWR,
  O_WRONLY,
  readCString,
} from "./platform.ts";
import { FsTree } from "./tree.ts";
import {
  handleHasBufferedContent,
  handleHasPendingChanges,
  HandleMap,
  type HandleState,
} from "./handles.ts";
import { buildNodeStat, getMountOwnership, nodeMode } from "./stat.ts";

const encoder = new TextEncoder();

// Operation ring buffer — last 50 ops for crash diagnostics
const OP_RING: string[] = [];
const OP_RING_SIZE = 50;
function logOp(name: string, detail: string): void {
  const entry = `${Date.now()} ${name} ${detail}`;
  if (OP_RING.length >= OP_RING_SIZE) OP_RING.shift();
  OP_RING.push(entry);
}
function dumpOpRing(): void {
  console.error("[fuse:crash] Last operations:");
  for (const e of OP_RING) console.error("  " + e);
}

// Prevent uncaught errors from crashing the FUSE daemon.
// Pattern recomputation and cell operations can throw from setTimeout
// callbacks (e.g. "Cannot create cell link - space required"). These
// errors should be logged, not fatal.
globalThis.addEventListener("unhandledrejection", (e) => {
  dumpOpRing();
  console.error("[FUSE] Unhandled promise rejection:", e.reason);
  e.preventDefault();
});

globalThis.addEventListener("error", (e) => {
  dumpOpRing();
  console.error("[FUSE] Uncaught error:", e.error ?? e.message);
  e.preventDefault();
});

type HandleWriteTarget =
  | { kind: "handler"; target: HandlerTarget }
  | { kind: "value"; target: WritePath }
  | { kind: "source"; target: SourceWritePath };

export async function main(argv: string[] = Deno.args) {
  const args = parseArgs(argv, {
    string: ["api-url", "space", "identity", "exec-cli", "log-file"],
    boolean: ["debug"],
    collect: ["space"],
    default: {
      "api-url": Deno.env.get("CT_API_URL") ?? "",
      space: [] as string[],
      identity: Deno.env.get("CT_IDENTITY") ?? "",
      "exec-cli": "",
      "log-file": "",
      debug: false,
    },
  });

  // Redirect console output to a log file when running as a background daemon.
  const logFilePath = args["log-file"] as string;
  if (logFilePath) {
    const logFile = await Deno.open(logFilePath, {
      create: true,
      append: true,
    });
    const enc = new TextEncoder();
    const write = (msg: string) => {
      try {
        logFile.writeSync(enc.encode(msg + "\n"));
      } catch {
        // Ignore write errors (disk full, etc.)
      }
    };
    console.log = (...a: unknown[]) => write(a.map(String).join(" "));
    console.error = (...a: unknown[]) => write(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => write(a.map(String).join(" "));
  }

  const debug = args.debug;

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

  // Open libfuse via platform abstraction
  const platform = await getPlatform();
  const fuse = platform.openFuse();
  const {
    STAT_SIZE,
    ENTRY_PARAM_SIZE,
    OPS_SIZE,
    OPS_OFFSETS,
    STAT_ST_SIZE_OFFSET,
    writeStat,
    writeEntryParam,
    readFileInfo,
    writeFileInfo,
    O_TRUNC,
    ENODATA,
  } = platform;

  // Create filesystem tree
  const tree = new FsTree();
  const mountOwnership = getMountOwnership();

  let bridge: CellBridge | null = null;
  const scheduledFlushes = new WeakMap<
    HandleState,
    ReturnType<typeof setTimeout>
  >();

  // Populate tree
  const apiUrl = args["api-url"];
  if (apiUrl) {
    bridge = new CellBridge(tree, args["exec-cli"] || "");
    bridge.init({
      apiUrl,
      identity: args.identity || "",
    });
    bridge.setDebug(debug);
    bridge.initStatus();

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

  function buildStat(
    node: NonNullable<ReturnType<typeof tree.getNode>>,
    ino: bigint,
  ) {
    return buildNodeStat(node, ino, {
      isWritable: Boolean(
        bridge?.resolveWritePath(ino) || bridge?.resolveSourceWritePath(ino),
      ),
      ownership: mountOwnership,
    });
  }

  function replyEntry(
    req: Deno.PointerValue,
    ino: bigint,
    node: ReturnType<typeof tree.getNode>,
  ) {
    const entryBuf = new ArrayBuffer(ENTRY_PARAM_SIZE);
    writeEntryParam(entryBuf, {
      ino,
      attr: buildStat(node!, ino),
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
      logOp("lookup", parentIno.toString());
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

      // On-demand entity resolution under <space>/entities/
      if (bridge && !name.startsWith(".") && bridge.isEntitiesDir(parent)) {
        bridge.resolveEntity(parent, name).then((resolved) => {
          if (resolved) {
            const newIno = tree.lookup(parent, name);
            if (newIno !== undefined) {
              const newNode = tree.getNode(newIno);
              if (newNode) {
                replyEntry(req, newIno, newNode);
                return;
              }
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
      logOp("forget", _ino.toString());
      fuse.symbols.fuse_reply_none(req);
    },
  );
  callbacks.push(forgetCb);

  // getattr(req, ino, fi_ptr)
  const getattrCb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "u64", "pointer"], result: "void" } as const,
    (req: Deno.PointerValue, ino: number | bigint, _fi: Deno.PointerValue) => {
      logOp("getattr", ino.toString());
      const inode = BigInt(ino);
      const node = tree.getNode(inode);

      if (!node) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      const statBuf = new ArrayBuffer(STAT_SIZE);
      writeStat(statBuf, buildStat(node, inode));

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
      logOp("readlink", ino.toString());
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
      logOp("open", ino.toString());
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

      const { flags } = readFileInfo(fi);
      const isWriting = (flags & O_WRONLY) !== 0 || (flags & O_RDWR) !== 0;

      if (node.kind === "callable") {
        if (node.callableKind === "tool" && isWriting) {
          fuse.symbols.fuse_reply_err(req, EACCES);
          return;
        }

        let writeTarget: HandleWriteTarget | undefined;
        if (node.callableKind === "handler" && isWriting) {
          const handlerTarget = bridge?.resolveHandlerTarget(inode);
          if (!handlerTarget) {
            fuse.symbols.fuse_reply_err(req, EACCES);
            return;
          }
          writeTarget = { kind: "handler", target: handlerTarget };
        }
        const truncate = (flags & O_TRUNC) !== 0;
        const initialBuffer = node.callableKind === "handler" && isWriting
          ? new Uint8Array(0)
          : truncate
          ? new Uint8Array(0)
          : node.script;
        const fh = handles.open(
          inode,
          flags,
          initialBuffer,
          { writeTarget },
        );
        if (truncate) {
          handles.markTruncated(fh);
        }
        writeFileInfo(fi, fh);
        fuse.symbols.fuse_reply_open(req, fi);
        return;
      }

      let writeTarget: HandleWriteTarget | undefined;
      if (isWriting && bridge) {
        const sourceWritePath = bridge.resolveSourceWritePath(inode);
        if (sourceWritePath) {
          writeTarget = { kind: "source", target: sourceWritePath };
        } else {
          const writePath = bridge.resolveWritePath(inode);
          if (!writePath) {
            fuse.symbols.fuse_reply_err(req, EACCES);
            return;
          }
          writeTarget = { kind: "value", target: writePath };
        }
      }

      // Get current content for the handle buffer
      const content = node.kind === "file" ? node.content : new Uint8Array(0);
      const truncate = (flags & O_TRUNC) !== 0;
      const fh = handles.open(
        inode,
        flags,
        truncate ? new Uint8Array(0) : content,
        { writeTarget },
      );
      if (truncate) {
        handles.markTruncated(fh);
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
      logOp("read", ino.toString());
      const inode = BigInt(ino);

      // If we have an open handle with a buffer, read from it
      const { fh } = readFileInfo(fi);
      const handle = handles.get(fh);
      if (handleHasBufferedContent(handle)) {
        const off = Number(offset);
        const sz = Number(size);
        const data = handle!.buffer;
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
      if (!node || (node.kind !== "file" && node.kind !== "callable")) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      const off = Number(offset);
      const sz = Number(size);
      const data = node.kind === "file" ? node.content : node.script;

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
      logOp("opendir", ino.toString());
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
      logOp("readdir", ino.toString());
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
          mode: nodeMode(
            childNode,
            Boolean(bridge?.resolveWritePath(childIno)),
          ),
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
          uid: mountOwnership.uid,
          gid: mountOwnership.gid,
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
    if (
      !handle || !handleHasPendingChanges(handle) || !bridge || handle.flushing
    ) {
      return 0;
    }
    handle.flushing = true;
    const flushVersion = handle.version;
    const buffer = handle.buffer.slice();
    const writeTarget = handle.writeTarget as HandleWriteTarget | undefined;

    const callableNode = tree.getNode(handle.ino);
    try {
      if (writeTarget?.kind === "handler") {
        const text = new TextDecoder().decode(buffer);
        const value = JSON.parse(text.trim());
        await bridge.sendToHandlerTarget(writeTarget.target, value);
        if (handle.version === flushVersion) {
          handle.dirty = false;
          handle.truncatePending = false;
          handle.buffer = new Uint8Array(0); // fire-and-forget
        }
        return 0;
      }

      if (writeTarget?.kind === "source") {
        const { piece, relPath, srcIno } = writeTarget.target;
        const text = new TextDecoder().decode(buffer);

        // Optimistically update the file content in the tree
        let fileIno: bigint | undefined = srcIno;
        for (const part of relPath.split("/")) {
          fileIno = fileIno !== undefined
            ? tree.lookup(fileIno, part)
            : undefined;
        }
        if (fileIno !== undefined) {
          try {
            tree.updateFile(fileIno, text);
          } catch {
            // Ignore stale inode
          }
        }

        // Get current meta to build the updated program
        let meta: Awaited<ReturnType<typeof piece.getPatternMeta>> | undefined;
        try {
          meta = await piece.getPatternMeta();
        } catch (e) {
          console.error(`[source] Failed to get pattern meta: ${e}`);
          return EACCES;
        }

        if (!meta?.program) {
          return EACCES;
        }

        // Replace the written file's content in the files array
        const updatedFiles = meta.program.files.map((f) => {
          const fRelPath = f.name.startsWith("/") ? f.name.slice(1) : f.name;
          return fRelPath === relPath ? { ...f, contents: text } : f;
        });

        try {
          await piece.setPattern({
            main: meta.program.main,
            mainExport: meta.program.mainExport,
            files: updatedFiles,
          });
          // Clear error.log on success
          const errorLogIno = tree.lookup(srcIno, "error.log");
          if (errorLogIno !== undefined) {
            tree.updateFile(errorLogIno, "");
          }
          if (handle.version === flushVersion) {
            handle.dirty = false;
            handle.truncatePending = false;
          }
          return 0;
        } catch (e) {
          // Write compile error to error.log
          const errorMsg = e instanceof Error ? e.message : String(e);
          const errorLogIno = tree.lookup(srcIno, "error.log");
          if (errorLogIno !== undefined) {
            tree.updateFile(errorLogIno, errorMsg);
          }
          console.error(`[source] Compile error in ${relPath}: ${errorMsg}`);
          return EACCES;
        }
      }

      if (
        callableNode?.kind === "callable" &&
        callableNode.callableKind === "tool"
      ) {
        return EACCES;
      }

      const writePath = writeTarget?.kind === "value"
        ? writeTarget.target
        : bridge.resolveWritePath(handle.ino);
      if (!writePath) return EACCES;

      const text = new TextDecoder().decode(buffer);

      // [FS] projection index file: parse and write back to cells
      if (writePath.fsProjection) {
        const ok = await bridge.writeFsFile(writePath, text);
        if (!ok) return EINVAL;
        if (handle.version === flushVersion) {
          handle.dirty = false;
          handle.truncatePending = false;
        }
        try {
          const node = tree.getNode(handle.ino);
          if (node && node.kind === "file") {
            tree.updateFile(handle.ino, text);
          }
        } catch {
          // Stale inode after subscription rebuild — ignore.
        }
        return 0;
      }

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
      if (handle.version === flushVersion) {
        handle.dirty = false;
        handle.truncatePending = false;
      }

      // Optimistic tree update: update the file node content immediately.
      // The inode may have been invalidated by the subscription rebuild
      // triggered during writeValue — ignore stale references.
      try {
        const node = tree.getNode(handle.ino);
        if (node && node.kind === "file") {
          tree.updateFile(handle.ino, text);
        }
      } catch {
        // Stale inode after subscription rebuild — subscription already
        // rebuilt the tree with the correct data.
      }

      return 0;
    } catch (e) {
      const logPrefix = writeTarget?.kind === "handler" ||
          (callableNode?.kind === "callable" &&
            callableNode.callableKind === "handler")
        ? "[fuse] handler flush error"
        : "[fuse] flush error";
      console.error(`${logPrefix}: ${e}`);
      return EIO;
    } finally {
      handle.flushing = false;
      if (handleHasPendingChanges(handle) && handle.version !== flushVersion) {
        queueMicrotask(() => {
          flushHandle(handle).catch((e) => {
            console.error(`[fuse] flush retry error: ${e}`);
          });
        });
      }
    }
  }

  function clearScheduledFlush(
    handle: NonNullable<ReturnType<typeof handles.get>>,
  ): void {
    const timer = scheduledFlushes.get(handle);
    if (timer !== undefined) {
      clearTimeout(timer);
      scheduledFlushes.delete(handle);
    }
  }

  function scheduleFlush(
    handle: NonNullable<ReturnType<typeof handles.get>>,
    delayMs: number,
  ): void {
    clearScheduledFlush(handle);
    const timer = setTimeout(() => {
      scheduledFlushes.delete(handle);
      if (handle.flushing) {
        // A flush is already in flight; retry shortly so we commit the latest
        // stable buffer rather than an intermediate chunk from a multi-write save.
        scheduleFlush(handle, 10);
        return;
      }
      flushHandle(handle).catch((e) => {
        console.error(`[fuse] scheduled flush error: ${e}`);
      });
    }, delayMs);
    scheduledFlushes.set(handle, timer);
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
      logOp("write", _ino.toString());
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
      fuse.symbols.fuse_reply_write(req, BigInt(sz));
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
      logOp("flush", _ino.toString());
      const { fh } = readFileInfo(fi);
      const handle = handles.get(fh);

      if (!handle || !handleHasPendingChanges(handle) || handle.flushing) {
        fuse.symbols.fuse_reply_err(req, 0);
        return;
      }

      // Reply immediately — the subscription rebuild triggered by writeValue
      // must not run while a FUSE reply is still pending (it invalidates
      // inodes via notify_inval_entry which crashes FUSE-T mid-callback).
      fuse.symbols.fuse_reply_err(req, 0);

      // Fire-and-forget the actual write to the cell
      const writeTarget = handle.writeTarget as HandleWriteTarget | undefined;
      const shouldDelay = handle.truncatePending ||
        (writeTarget?.kind === "value" &&
          writeTarget.target.fsProjection === "markdown");
      if (shouldDelay) {
        // Markdown saves often arrive as several small writes plus flushes.
        // Empty O_TRUNC opens can also flush before the writer sends content.
        // Delay slightly so we commit settled data instead of an intermediate
        // empty/truncated buffer.
        scheduleFlush(handle, 25);
      } else {
        flushHandle(handle).catch((e) => {
          console.error(`[fuse] flush write error: ${e}`);
        });
      }
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
      logOp("setattr", ino.toString());
      const inode = BigInt(ino);
      const node = tree.getNode(inode);
      if (!node) {
        fuse.symbols.fuse_reply_err(req, ENOENT);
        return;
      }

      // Handle truncate / size change
      if (toSet & FUSE_SET_ATTR_SIZE) {
        // Read new size from attr struct
        const attrView = new Deno.UnsafePointerView(_attrPtr!);
        const newSize = Number(attrView.getBigInt64(STAT_ST_SIZE_OFFSET));
        const { fh } = readFileInfo(fi);
        const handle = handles.get(fh);
        if (handle) {
          handles.truncate(fh, newSize);
        } else {
          // No valid fh — NFS/FUSE-T calls setattr(size=0) separately.
          // Truncate all open handles for this inode and the tree node.
          handles.truncateByIno(inode, newSize);
          if (node.kind === "file") {
            tree.updateFile(
              inode,
              newSize === 0 ? "" : node.content.slice(0, newSize),
            );
          }
        }
      }

      // Reply with current attrs (silently accept chmod/chown/times)
      const statBuf = new ArrayBuffer(STAT_SIZE);
      writeStat(statBuf, buildStat(node, inode));
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
      logOp("release", _ino.toString());
      const { fh } = readFileInfo(fi);
      const handle = handles.get(fh);

      // Reply immediately and close the handle.
      // Fire-and-forget the write if dirty.
      if (handle && handleHasPendingChanges(handle) && bridge) {
        const writeTarget = handle.writeTarget as HandleWriteTarget | undefined;
        if (
          handle.truncatePending && !handle.dirty && !handle.flushing
        ) {
          flushHandle(handle).catch((e) => {
            console.error(`[fuse] release flush error: ${e}`);
          });
        } else if (
          writeTarget?.kind === "value" &&
          writeTarget.target.fsProjection === "markdown"
        ) {
          scheduleFlush(handle, 0);
        } else if (!handle.flushing) {
          flushHandle(handle).catch((e) => {
            console.error(`[fuse] release flush error: ${e}`);
          });
        }
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
      logOp("releasedir", _ino.toString());
      fuse.symbols.fuse_reply_err(req, 0); // success
    },
  );
  callbacks.push(releasedirCb);

  // getxattr — platform factory handles macOS extra `position` param vs Linux 4-param signature
  const getxattrCb = platform.createGetxattrCallback(
    (
      req: Deno.PointerValue,
      ino: bigint,
      namePtr: Deno.PointerValue,
      size: bigint,
    ) => {
      logOp("getxattr", ino.toString());
      const attrName = readCString(namePtr);
      const node = tree.getNode(ino);

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
      logOp("create", parentIno.toString());
      if (!bridge) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const parent = BigInt(parentIno);
      const name = readCString(namePtr);

      // Reject macOS resource fork / metadata files
      if (name.startsWith("._")) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const parentPath = bridge.resolveWritePath(parent);

      if (!parentPath) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      // Optimistic: create file node and reply immediately, then write to cell.
      const ino = tree.addFile(parent, name, "", "string");
      const fh = handles.open(
        ino,
        O_RDWR,
        new Uint8Array(0),
        {
          writeTarget: {
            kind: "value",
            target: { ...parentPath, jsonPath: [...parentPath.jsonPath, name] },
          } satisfies HandleWriteTarget,
        },
      );
      writeFileInfo(fi, fh);

      const entryBuf = new ArrayBuffer(ENTRY_PARAM_SIZE);
      writeEntryParam(entryBuf, {
        ino,
        attr: {
          ino,
          mode: FILE_MODE_RW,
          nlink: 1,
          size: 0,
          uid: mountOwnership.uid,
          gid: mountOwnership.gid,
        },
        attrTimeout: 1.0,
        entryTimeout: 1.0,
      });

      fuse.symbols.fuse_reply_create(
        req,
        Deno.UnsafePointer.of(new Uint8Array(entryBuf)),
        fi,
      );

      // Fire-and-forget write to cell
      const newPath = [...parentPath.jsonPath, name];
      bridge.writeValue(
        { ...parentPath, jsonPath: newPath },
        "",
      ).catch((e) => {
        console.error(`[fuse] create write error: ${e}`);
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
      logOp("mkdir", parentIno.toString());
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

      // Optimistic: create dir and reply immediately, then write to cell.
      const ino = tree.addDir(parent, name, "object");
      const node = tree.getNode(ino);
      replyEntry(req, ino, node);

      // Fire-and-forget write to cell
      const newPath = [...parentPath.jsonPath, name];
      bridge.writeValue(
        { ...parentPath, jsonPath: newPath },
        {},
      ).catch((e) => {
        console.error(`[fuse] mkdir write error: ${e}`);
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
      logOp("unlink", parentIno.toString());
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

      // Optimistic: remove from tree and reply immediately
      tree.removeChild(parent, name);
      if (name.endsWith(".json")) {
        const dirName = name.slice(0, -5);
        const dirIno = tree.lookup(parent, dirName);
        if (dirIno !== undefined) tree.removeChild(parent, dirName);
      } else {
        const jsonIno = tree.lookup(parent, `${name}.json`);
        if (jsonIno !== undefined) tree.removeChild(parent, `${name}.json`);
      }
      fuse.symbols.fuse_reply_err(req, 0);

      // Fire-and-forget the cell write (skip the tree updates in doUnlink
      // since we already did them above)
      (async () => {
        if (isArrayParent) {
          const parentPath = bridge!.resolveWritePath(parent);
          if (!parentPath) return;
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
          if (!parentPath) return;
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
      })().catch((e) => {
        console.error(`[fuse] unlink write error: ${e}`);
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
      logOp("rmdir", parentIno.toString());
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

      // Optimistic: remove from tree and reply immediately
      tree.removeChild(parent, name);
      const jsonIno = tree.lookup(parent, `${name}.json`);
      if (jsonIno !== undefined) tree.removeChild(parent, `${name}.json`);
      fuse.symbols.fuse_reply_err(req, 0);

      // Fire-and-forget the cell write
      (async () => {
        if (isArrayParent) {
          const parentPath = bridge!.resolveWritePath(parent);
          if (!parentPath) return;
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
          if (!parentPath) return;
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
      })().catch((e) => {
        console.error(`[fuse] rmdir write error: ${e}`);
      });
    },
  );
  callbacks.push(rmdirCb);

  // rename — platform factory handles Linux v3 extra `flags` param
  const renameCb = platform.createRenameCallback(
    (
      req: Deno.PointerValue,
      parentIno: bigint,
      namePtr: Deno.PointerValue,
      newParentIno: bigint,
      newNamePtr: Deno.PointerValue,
    ) => {
      logOp("rename", parentIno.toString());
      if (!bridge) {
        fuse.symbols.fuse_reply_err(req, EACCES);
        return;
      }

      const oldParent = parentIno;
      const oldName = readCString(namePtr);
      const newParent = newParentIno;
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
      };

      // Optimistic: rename in tree and reply immediately
      tree.rename(oldParent, oldName, newParent, newName);
      fuse.symbols.fuse_reply_err(req, 0);

      // Fire-and-forget the cell writes
      doRename().catch((e) => {
        console.error(`[fuse] rename write error: ${e}`);
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

      // Optimistic: add to tree and reply immediately, then write to cell.
      // The subscription rebuild will eventually replace this node.
      const ino = tree.addSymlink(parent, name, target);
      const node = tree.getNode(ino);
      replyEntry(req, ino, node);

      // Fire-and-forget write to cell
      bridge.writeValue(writePath, sigilValue).catch((e) => {
        console.error(`[fuse] symlink write error: ${e}`);
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
  const { argsBuf, argv: _argv, encodedArgs: _ea } = platform.createFuseArgs([
    "fuse_ct",
  ]);

  const mountpointBuf = encoder.encode(mountpoint + "\0");

  let handle: ReturnType<typeof platform.mount>;
  try {
    handle = platform.mount(
      fuse,
      mountpointBuf,
      argsBuf,
      opsBuf,
      BigInt(OPS_SIZE),
    );
  } catch (e) {
    console.error(String(e));
    Deno.exit(1);
  }
  // handle is guaranteed assigned — Deno.exit(1) never returns

  let unmounting = false;

  // Wire up kernel cache invalidation for subscriptions
  if (bridge) {
    let notifySupported = true;
    bridge.onInvalidate = (parentIno: bigint, names: string[]) => {
      if (!notifySupported || unmounting) return;
      for (const name of names) {
        const nameBuf = encoder.encode(name + "\0");
        const rc = fuse.symbols.fuse_lowlevel_notify_inval_entry(
          handle.notifyTarget,
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
    bridge.onInvalidateInode = (ino: bigint) => {
      if (unmounting) return;
      // Invalidate all cached data for this inode (off=0, len=-1 means all)
      const ret = fuse.symbols.fuse_lowlevel_notify_inval_inode(
        handle.notifyTarget,
        ino,
        0n,
        -1n,
      );
      if (debug) {
        console.log(`notify_inval_inode(ino=${ino}) => ${ret}`);
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
    platform.unmount(fuse, handle, mountpointBuf);
  }

  Deno.addSignalListener("SIGINT", () => {
    unmount();
  });
  Deno.addSignalListener("SIGTERM", () => {
    unmount();
  });

  // Run FUSE event loop (nonblocking: true → returns Promise)
  const result = await fuse.symbols.fuse_session_loop(handle.session);
  console.log(`FUSE loop exited (code ${result})`);

  // Final cleanup
  platform.cleanup(fuse, handle, mountpointBuf, unmounting);
  for (const cb of callbacks) cb.close();
  console.log("Cleaned up.");
}

if (import.meta.main) {
  await main();
}
