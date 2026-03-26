// platform.ts — Shared types, constants, and platform dispatcher for FUSE FFI.
//
// Platform-specific implementations live in platform-darwin.ts (FUSE v2) and
// platform-linux.ts (FUSE v3). This module provides the shared interface,
// constants that are identical across platforms, and a runtime dispatcher.

// --- Shared types ---

export interface StatOpts {
  ino: bigint;
  mode: number;
  nlink: number;
  size: number;
  uid?: number;
  gid?: number;
}

export interface EntryParamOpts {
  ino: bigint;
  generation?: bigint;
  attr: StatOpts;
  attrTimeout?: number;
  entryTimeout?: number;
}

export interface FileInfo {
  flags: number;
  fh: bigint;
}

export interface MountHandle {
  session: Deno.PointerValue;
  /** Channel pointer on macOS (FUSE v2), session pointer on Linux (FUSE v3). */
  notifyTarget: Deno.PointerValue;
}

// --- Common FFI symbols (identical between FUSE v2 and v3) ---

export const COMMON_SYMBOLS = {
  // Session lifecycle
  fuse_session_loop: {
    parameters: ["pointer"],
    result: "i32",
    nonblocking: true,
  },
  fuse_session_destroy: {
    parameters: ["pointer"],
    result: "void",
  },
  fuse_opt_free_args: {
    parameters: ["pointer"],
    result: "void",
  },

  // Reply functions (called from callbacks)
  fuse_reply_err: {
    parameters: ["pointer", "i32"],
    result: "i32",
  },
  fuse_reply_entry: {
    parameters: ["pointer", "pointer"],
    result: "i32",
  },
  fuse_reply_attr: {
    parameters: ["pointer", "pointer", "f64"],
    result: "i32",
  },
  fuse_reply_buf: {
    parameters: ["pointer", "pointer", "usize"],
    result: "i32",
  },
  fuse_reply_open: {
    parameters: ["pointer", "pointer"],
    result: "i32",
  },
  fuse_reply_readlink: {
    parameters: ["pointer", "buffer"],
    result: "i32",
  },
  fuse_reply_write: {
    parameters: ["pointer", "usize"],
    result: "i32",
  },
  fuse_reply_create: {
    parameters: ["pointer", "pointer", "pointer"],
    result: "i32",
  },
  fuse_reply_xattr: {
    parameters: ["pointer", "usize"],
    result: "i32",
  },
  fuse_reply_none: {
    parameters: ["pointer"],
    result: "void",
  },

  // Directory entry helper
  fuse_add_direntry: {
    parameters: ["pointer", "pointer", "usize", "buffer", "pointer", "i64"],
    result: "usize",
  },

  // Kernel cache invalidation (FUSE 2.8+ / FUSE 3.x)
  // First param is channel (v2) or session (v3) — callers use MountHandle.notifyTarget.
  fuse_lowlevel_notify_inval_entry: {
    parameters: ["pointer", "u64", "buffer", "usize"],
    result: "i32",
  },
  fuse_lowlevel_notify_inval_inode: {
    parameters: ["pointer", "u64", "i64", "i64"],
    result: "i32",
  },
} as const;

export type FuseLib = Deno.DynamicLibrary<typeof COMMON_SYMBOLS>;

// --- Platform interface ---

// deno-lint-ignore no-explicit-any
type AnyCallback = Deno.UnsafeCallback<any>;

export interface FusePlatform {
  /** Open the platform-appropriate libfuse and return a lib with common symbols. */
  openFuse(): FuseLib;

  // Struct sizes
  STAT_SIZE: number;
  ENTRY_PARAM_SIZE: number;
  FUSE_FILE_INFO_SIZE: number;
  OPS_SIZE: number;
  OPS_OFFSETS: Readonly<Record<string, number>>;
  FUSE_ARGS_STRUCT_SIZE: number;
  /** Byte offset of st_size within struct stat. */
  STAT_ST_SIZE_OFFSET: number;

  // Struct helpers
  writeStat(buf: ArrayBuffer, opts: StatOpts): void;
  writeEntryParam(buf: ArrayBuffer, opts: EntryParamOpts): void;
  readFileInfo(ptr: Deno.PointerValue): FileInfo;
  writeFileInfo(ptr: Deno.PointerValue, fh: bigint): void;
  createFuseArgs(args: string[]): {
    argsBuf: ArrayBuffer;
    argv: Deno.PointerValue;
    argvBuf: BigUint64Array;
    encodedArgs: Uint8Array[];
  };

  // Platform-varying constants
  O_CREAT: number;
  O_TRUNC: number;
  O_APPEND: number;
  ENOTEMPTY: number;
  ENOSYS: number;
  ENODATA: number;
  /** Byte offset of fh within fuse_file_info. */
  FH_OFFSET: number;

  // Callback factories for ops with platform-varying signatures.
  // macOS getxattr has extra `position` param; Linux rename has extra `flags` param.
  createGetxattrCallback(
    handler: (
      req: Deno.PointerValue,
      ino: bigint,
      namePtr: Deno.PointerValue,
      size: bigint,
    ) => void,
  ): AnyCallback;

  createRenameCallback(
    handler: (
      req: Deno.PointerValue,
      parent: bigint,
      namePtr: Deno.PointerValue,
      newparent: bigint,
      newnamePtr: Deno.PointerValue,
    ) => void,
  ): AnyCallback;

  // Mount lifecycle
  mount(
    lib: FuseLib,
    mountpoint: Uint8Array,
    argsBuf: ArrayBuffer,
    opsBuf: ArrayBuffer,
    opsSize: bigint,
  ): MountHandle;

  unmount(
    lib: FuseLib,
    handle: MountHandle,
    mountpoint: Uint8Array,
  ): void;

  cleanup(
    lib: FuseLib,
    handle: MountHandle,
    mountpoint: Uint8Array,
    alreadyUnmounted: boolean,
  ): void;
}

// --- Shared constants (identical on macOS and Linux) ---

// Errno constants (POSIX-standard values)
export const ENOENT = 2;
export const EIO = 5;
export const EACCES = 13;
export const EEXIST = 17;
export const EXDEV = 18;
export const ENOTDIR = 20;
export const EISDIR = 21;
export const EINVAL = 22;
export const ENOSPC = 28;
export const EROFS = 30;
export const ERANGE = 34;

// O_* flags (these three are POSIX-standard)
export const O_RDONLY = 0x0000;
export const O_WRONLY = 0x0001;
export const O_RDWR = 0x0002;

// setattr to_set flags
export const FUSE_SET_ATTR_SIZE = 1 << 3;

// File mode constants
export const S_IFDIR = 0o40000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;
export const S_IRWXU = 0o700;
export const S_IRWXG = 0o070;
export const S_IRWXO = 0o007;

// Common modes
export const DIR_MODE = S_IFDIR | 0o755;
export const FILE_MODE = S_IFREG | 0o444;
export const FILE_MODE_RW = S_IFREG | 0o644;
export const FILE_MODE_RX = S_IFREG | 0o555;
export const FILE_MODE_RWX = S_IFREG | 0o755;
export const FILE_MODE_WO = S_IFREG | 0o200;
export const SYMLINK_MODE = S_IFLNK | 0o777;

// --- Shared utility ---

export function readCString(ptr: Deno.PointerValue): string {
  if (!ptr) return "";
  const view = new Deno.UnsafePointerView(ptr);
  return view.getCString();
}

// --- Shared struct helpers ---

/**
 * Build a writeEntryParam function using the given platform's writeStat and STAT_SIZE.
 * Called by each platform module to avoid duplicating the entry_param layout logic
 * (which is the same on both platforms — only the embedded stat layout differs).
 */
export function makeWriteEntryParam(
  writeStat: (buf: ArrayBuffer, opts: StatOpts) => void,
  statSize: number,
  entryParamSize: number,
) {
  return function writeEntryParam(
    buf: ArrayBuffer,
    opts: EntryParamOpts,
  ): void {
    const view = new DataView(buf);
    new Uint8Array(buf).fill(0);

    // fuse_entry_param layout (same on both platforms):
    //   ino_t ino          @ 0   (u64)
    //   u64 generation     @ 8   (u64)
    //   struct stat attr   @ 16  (STAT_SIZE bytes)
    //   double attr_timeout  @ 16 + STAT_SIZE
    //   double entry_timeout @ 16 + STAT_SIZE + 8
    view.setBigUint64(0, opts.ino, true);
    view.setBigUint64(8, opts.generation ?? 0n, true);

    const statBuf = new ArrayBuffer(statSize);
    writeStat(statBuf, opts.attr);
    new Uint8Array(buf, 16, statSize).set(new Uint8Array(statBuf));

    const timeoutBase = 16 + statSize;
    view.setFloat64(timeoutBase, opts.attrTimeout ?? 1.0, true);
    view.setFloat64(timeoutBase + 8, opts.entryTimeout ?? 1.0, true);

    // Sanity: ensure we haven't overflowed
    if (timeoutBase + 16 > entryParamSize) {
      throw new Error(
        `writeEntryParam: timeouts overflow entry_param (${
          timeoutBase + 16
        } > ${entryParamSize})`,
      );
    }
  };
}

/**
 * Build a createFuseArgs function. The fuse_args struct layout is the same on
 * both platforms: { int argc; char **argv; int allocated; } with natural
 * alignment padding on 64-bit (total 24 bytes).
 */
export function createFuseArgs(
  args: string[],
  argsStructSize: number,
): {
  argsBuf: ArrayBuffer;
  argv: Deno.PointerValue;
  argvBuf: BigUint64Array;
  encodedArgs: Uint8Array[];
} {
  const encoder = new TextEncoder();
  const encodedArgs = args.map((a) => encoder.encode(a + "\0"));

  const argvBuf = new BigUint64Array(args.length);
  for (let i = 0; i < encodedArgs.length; i++) {
    argvBuf[i] = BigInt(
      Deno.UnsafePointer.value(Deno.UnsafePointer.of(encodedArgs[i])),
    );
  }

  const argv = Deno.UnsafePointer.of(argvBuf);

  const argsBuf = new ArrayBuffer(argsStructSize);
  const view = new DataView(argsBuf);
  view.setInt32(0, args.length, true); // argc
  view.setBigUint64(8, BigInt(Deno.UnsafePointer.value(argv)), true); // argv
  view.setInt32(16, 0, true); // allocated

  return { argsBuf, argv, argvBuf, encodedArgs };
}

// --- Platform dispatcher ---

let _platform: FusePlatform | null = null;

export async function getPlatform(): Promise<FusePlatform> {
  if (_platform) return _platform;
  if (Deno.build.os === "darwin") {
    const mod = await import("./platform-darwin.ts");
    _platform = mod.default;
    return _platform;
  }
  if (Deno.build.os === "linux") {
    const mod = await import("./platform-linux.ts");
    _platform = mod.default;
    return _platform;
  }
  throw new Error(`Unsupported platform: ${Deno.build.os}`);
}
