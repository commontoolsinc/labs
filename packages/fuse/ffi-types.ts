// ffi-types.ts — C struct layouts for macFUSE (macOS arm64)

// struct stat (144 bytes on macOS arm64)
// Key field offsets:
//   dev_t st_dev      @ 0   (i32)
//   mode_t st_mode    @ 4   (u16)
//   nlink_t st_nlink  @ 6   (u16)
//   ino_t st_ino      @ 8   (u64)
//   uid_t st_uid      @ 16  (u32)
//   gid_t st_gid      @ 20  (u32)
//   ...
//   off_t st_size     @ 96  (i64)
//   ...
//   Total: 144 bytes

export const STAT_SIZE = 144;

export interface StatOpts {
  ino: bigint;
  mode: number;
  nlink: number;
  size: number;
  uid?: number;
  gid?: number;
}

export function writeStat(buf: ArrayBuffer, opts: StatOpts): void {
  const view = new DataView(buf);
  // Zero out
  new Uint8Array(buf).fill(0);

  view.setUint16(4, opts.mode, true); // st_mode
  view.setUint16(6, opts.nlink, true); // st_nlink
  view.setBigUint64(8, opts.ino, true); // st_ino
  view.setUint32(16, opts.uid ?? 0, true); // st_uid
  view.setUint32(20, opts.gid ?? 0, true); // st_gid
  view.setBigInt64(96, BigInt(opts.size), true); // st_size
}

// fuse_entry_param (176 bytes)
// Layout:
//   ino_t ino          @ 0   (u64)
//   u64 generation     @ 8   (u64)
//   struct stat attr   @ 16  (144 bytes)
//   double attr_timeout  @ 160 (f64)
//   double entry_timeout @ 168 (f64)

export const ENTRY_PARAM_SIZE = 176;

export interface EntryParamOpts {
  ino: bigint;
  generation?: bigint;
  attr: StatOpts;
  attrTimeout?: number;
  entryTimeout?: number;
}

export function writeEntryParam(buf: ArrayBuffer, opts: EntryParamOpts): void {
  const view = new DataView(buf);
  new Uint8Array(buf).fill(0);

  view.setBigUint64(0, opts.ino, true); // ino
  view.setBigUint64(8, opts.generation ?? 0n, true); // generation

  // Write stat into the embedded struct at offset 16
  const statBuf = new ArrayBuffer(STAT_SIZE);
  writeStat(statBuf, opts.attr);
  new Uint8Array(buf, 16, STAT_SIZE).set(new Uint8Array(statBuf));

  view.setFloat64(160, opts.attrTimeout ?? 1.0, true); // attr_timeout
  view.setFloat64(168, opts.entryTimeout ?? 1.0, true); // entry_timeout
}

// fuse_file_info (partial read — we only need flags and fh)
// Layout:
//   int flags     @ 0  (i32)
//   ...
//   uint64_t fh   @ 16 (u64)

export interface FileInfo {
  flags: number;
  fh: bigint;
}

export const FUSE_FILE_INFO_SIZE = 64;

export function readFileInfo(ptr: Deno.PointerValue): FileInfo {
  if (!ptr) {
    return { flags: 0, fh: 0n };
  }
  const view = new Deno.UnsafePointerView(ptr);
  return {
    flags: view.getInt32(0),
    fh: view.getBigUint64(16),
  };
}

/** Write the fh field at offset 16 of a fuse_file_info struct. */
export function writeFileInfo(ptr: Deno.PointerValue, fh: bigint): void {
  if (!ptr) return;
  // The fi pointer refers to FUSE's stack memory — get a writable view.
  const fiArr = new BigUint64Array(
    Deno.UnsafePointerView.getArrayBuffer(ptr, FUSE_FILE_INFO_SIZE),
  );
  fiArr[2] = fh; // offset 16 = index 2 of u64 array
}

// O_* flags (macOS)
export const O_RDONLY = 0x0000;
export const O_WRONLY = 0x0001;
export const O_RDWR = 0x0002;
export const O_CREAT = 0x0200;
export const O_TRUNC = 0x0400;
export const O_APPEND = 0x0008;

// setattr to_set flags
export const FUSE_SET_ATTR_SIZE = 1 << 3;

// Errno constants (macOS)
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
export const ENOTEMPTY = 66; // macOS
export const ENOSYS = 78;
export const ENODATA = 93; // macOS ENOATTR — no such xattr

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
export const FILE_MODE_WO = S_IFREG | 0o200; // write-only (handlers)
export const SYMLINK_MODE = S_IFLNK | 0o777;

// fuse_lowlevel_ops struct — function pointer offsets (8 bytes each)
// This is the order from fuse_lowlevel.h:
//
// Slot 0:  init         @ 0
// Slot 1:  destroy      @ 8
// Slot 2:  lookup       @ 16
// Slot 3:  forget       @ 24
// Slot 4:  getattr      @ 32
// Slot 5:  setattr      @ 40
// Slot 6:  readlink     @ 48
// Slot 7:  mknod        @ 56
// Slot 8:  mkdir        @ 64
// Slot 9:  unlink       @ 72
// Slot 10: rmdir        @ 80
// Slot 11: symlink      @ 88
// Slot 12: rename       @ 96
// Slot 13: link         @ 104
// Slot 14: open         @ 112
// Slot 15: read         @ 120
// Slot 16: write        @ 128
// Slot 17: flush        @ 136
// Slot 18: release      @ 144
// Slot 19: fsync        @ 152
// Slot 20: opendir      @ 160
// Slot 21: readdir      @ 168
// Slot 22: releasedir   @ 176
// Slot 23: fsyncdir     @ 184
// Slot 24: statfs       @ 192
// Slot 25: setxattr     @ 200
// Slot 26: getxattr     @ 208
// Slot 27: listxattr    @ 216
// Slot 28: removexattr  @ 224
// Slot 29: access       @ 232
// Slot 30: create       @ 240
// ...more ops follow

export const OPS_SIZE = 320; // allocate enough for all ops

export const OPS_OFFSETS = {
  init: 0,
  destroy: 8,
  lookup: 16,
  forget: 24,
  getattr: 32,
  setattr: 40,
  readlink: 48,
  mknod: 56,
  mkdir: 64,
  unlink: 72,
  rmdir: 80,
  symlink: 88,
  rename: 96,
  link: 104,
  open: 112,
  read: 120,
  write: 128,
  flush: 136,
  release: 144,
  fsync: 152,
  opendir: 160,
  readdir: 168,
  releasedir: 176,
  fsyncdir: 184,
  statfs: 192,
  setxattr: 200,
  getxattr: 208,
  listxattr: 216,
  removexattr: 224,
  access: 232,
  create: 240,
} as const;

// Helper to read a C string from a pointer
export function readCString(ptr: Deno.PointerValue): string {
  if (!ptr) return "";
  const view = new Deno.UnsafePointerView(ptr);
  return view.getCString();
}

// fuse_args struct (for fuse_mount)
// struct fuse_args { int argc; char **argv; int allocated; }
export const FUSE_ARGS_SIZE = 16; // 4 + padding + 8 + 4

export function writeFuseArgs(
  buf: ArrayBuffer,
  argc: number,
  argvPtr: Deno.PointerValue,
): void {
  const view = new DataView(buf);
  view.setInt32(0, argc, true);
  // argv pointer at offset 8 (after 4 bytes padding on 64-bit)
  view.setBigUint64(8, BigInt(Deno.UnsafePointer.value(argvPtr)), true);
  view.setInt32(16, 0, true); // allocated = 0
}

// Actually fuse_args is { int argc; char **argv; int allocated; }
// On arm64: int(4) + padding(4) + pointer(8) + int(4) + padding(4) = 24 bytes
export const FUSE_ARGS_STRUCT_SIZE = 24;

export function createFuseArgs(
  args: string[],
): {
  argsBuf: ArrayBuffer;
  argv: Deno.PointerValue;
  encodedArgs: Uint8Array[];
} {
  const encoder = new TextEncoder();
  const encodedArgs = args.map((a) => encoder.encode(a + "\0"));

  // Create argv array (array of pointers)
  const argvBuf = new BigUint64Array(args.length);
  for (let i = 0; i < encodedArgs.length; i++) {
    argvBuf[i] = BigInt(
      Deno.UnsafePointer.value(Deno.UnsafePointer.of(encodedArgs[i])),
    );
  }

  const argv = Deno.UnsafePointer.of(argvBuf);

  // Create fuse_args struct
  const argsBuf = new ArrayBuffer(FUSE_ARGS_STRUCT_SIZE);
  const view = new DataView(argsBuf);
  view.setInt32(0, args.length, true); // argc
  view.setBigUint64(8, BigInt(Deno.UnsafePointer.value(argv)), true); // argv
  view.setInt32(16, 0, true); // allocated

  return { argsBuf, argv, encodedArgs };
}
