// ffi.ts — Deno FFI bindings to FUSE low-level API
//
// Supports FUSE-T (preferred, no kernel extension) and macFUSE (fallback).

const LIBFUSE_PATHS = [
  "/usr/local/lib/libfuse-t.dylib", // FUSE-T (kext-less, NFS v4 based)
  "/usr/local/lib/libfuse.2.dylib", // macFUSE (kernel extension)
];

const symbols = {
  // Mount/unmount
  fuse_mount: {
    parameters: ["buffer", "pointer"],
    result: "pointer",
  },
  fuse_unmount: {
    parameters: ["buffer", "pointer"],
    result: "void",
  },

  // Session management
  fuse_lowlevel_new: {
    parameters: ["pointer", "pointer", "usize", "pointer"],
    result: "pointer",
  },
  fuse_session_add_chan: {
    parameters: ["pointer", "pointer"],
    result: "void",
  },
  fuse_session_remove_chan: {
    parameters: ["pointer"],
    result: "void",
  },
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
  fuse_reply_none: {
    parameters: ["pointer"],
    result: "void",
  },

  // Directory entry helper
  fuse_add_direntry: {
    parameters: ["pointer", "pointer", "usize", "buffer", "pointer", "i64"],
    result: "usize",
  },
} as const;

let lib: Deno.DynamicLibrary<typeof symbols> | null = null;

export function openFuse(): Deno.DynamicLibrary<typeof symbols> {
  if (lib) return lib;

  const errors: string[] = [];
  for (const path of LIBFUSE_PATHS) {
    try {
      lib = Deno.dlopen(path, symbols);
      console.log(`Loaded ${path}`);
      return lib;
    } catch (e) {
      errors.push(`  ${path}: ${e}`);
    }
  }

  throw new Error(
    `Could not open libfuse. Install FUSE-T (recommended) or macFUSE:\n` +
      `  brew install fuse-t\n` +
      `  brew install --cask macfuse\n` +
      `Tried:\n${errors.join("\n")}`,
  );
}

export type FuseLib = Deno.DynamicLibrary<typeof symbols>;
