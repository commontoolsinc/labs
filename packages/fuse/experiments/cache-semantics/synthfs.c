// synthfs.c — minimal high-level FUSE-T filesystem for probing macOS NFS-client
// cache semantics. Layout:
//   /                      root dir
//   /dir                   a "prop dir" analog
//   /dir/pre               a file that ALWAYS exists (positive control)
//   /dir/target            a file that exists only AFTER APPEAR_AT seconds
//                          from mount start (the daemon-side "file appears" event)
//
// Every kernel request is logged to stderr with an epoch-ms timestamp so a
// driver script sharing the same clock can tell which stat()/readdir() calls
// reached the daemon vs. were served from the client cache.
//
// Env:
//   APPEAR_AT   seconds after mount when /dir/target begins to exist (default 5)
//   BUMP_MTIME  if "1", /dir's mtime jumps to the appear time once target
//               appears (models the proposed fix). Otherwise /dir mtime is a
//               constant (models CF, which reports no timestamps).
//
// Build:
//   cc -D_FILE_OFFSET_BITS=64 -DFUSE_USE_VERSION=26 synthfs.c \
//      -I"<inc>" -L/usr/local/lib -Wl,-rpath,/usr/local/lib -lfuse-t -o synthfs

#define FUSE_USE_VERSION 26
#include <fuse.h>
#include <string.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/time.h>
#include <unistd.h>

static struct timeval g_start;
static long g_appear_at = 5;   // seconds (fallback)
static long long g_appear_epoch_ms = 0; // absolute; overrides g_appear_at when set
static int  g_bump_mtime = 0;

static long long now_ms(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

// seconds since mount start
static double elapsed_s(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (tv.tv_sec - g_start.tv_sec) + (tv.tv_usec - g_start.tv_usec) / 1e6;
}

static int target_exists(void) {
    if (g_appear_epoch_ms > 0) return now_ms() >= g_appear_epoch_ms;
    return elapsed_s() >= (double)g_appear_at;
}

// epoch seconds at which target appeared (fixed), for the bump-mtime mode
static time_t appear_epoch(void) {
    if (g_appear_epoch_ms > 0) return (time_t)(g_appear_epoch_ms / 1000);
    return g_start.tv_sec + g_appear_at;
}

#define LOG(...) do { fprintf(stderr, "[fs %lld] ", now_ms()); \
                      fprintf(stderr, __VA_ARGS__); \
                      fprintf(stderr, "\n"); fflush(stderr); } while (0)

static int synth_getattr(const char *path, struct stat *st) {
    memset(st, 0, sizeof(*st));
    if (strcmp(path, "/") == 0) {
        st->st_mode = S_IFDIR | 0755; st->st_nlink = 2;
        LOG("getattr %s -> dir", path);
        return 0;
    }
    if (strcmp(path, "/dir") == 0) {
        st->st_mode = S_IFDIR | 0755; st->st_nlink = 2;
        // Constant mtime (0) models CF's no-timestamp stats. In bump mode, once
        // target exists the dir's mtime reflects the appear time.
        if (g_bump_mtime && target_exists()) {
            st->st_mtimespec.tv_sec = appear_epoch();
            st->st_ctimespec.tv_sec = appear_epoch();
        }
        LOG("getattr %s -> dir (mtime=%ld)", path, (long)st->st_mtimespec.tv_sec);
        return 0;
    }
    if (strcmp(path, "/dir/pre") == 0) {
        st->st_mode = S_IFREG | 0444; st->st_nlink = 1; st->st_size = 3;
        LOG("getattr %s -> file(exists)", path);
        return 0;
    }
    if (strcmp(path, "/dir/target") == 0) {
        if (target_exists()) {
            st->st_mode = S_IFREG | 0444; st->st_nlink = 1; st->st_size = 6;
            LOG("getattr %s -> file(EXISTS) elapsed=%.2f", path, elapsed_s());
            return 0;
        }
        LOG("getattr %s -> ENOENT elapsed=%.2f", path, elapsed_s());
        return -ENOENT;
    }
    LOG("getattr %s -> ENOENT (unknown)", path);
    return -ENOENT;
}

static int synth_readdir(const char *path, void *buf, fuse_fill_dir_t filler,
                         off_t offset, struct fuse_file_info *fi) {
    (void)offset; (void)fi;
    if (strcmp(path, "/") == 0) {
        LOG("readdir %s", path);
        filler(buf, ".", NULL, 0); filler(buf, "..", NULL, 0);
        filler(buf, "dir", NULL, 0);
        return 0;
    }
    if (strcmp(path, "/dir") == 0) {
        int te = target_exists();
        LOG("readdir %s (target_exists=%d) elapsed=%.2f", path, te, elapsed_s());
        filler(buf, ".", NULL, 0); filler(buf, "..", NULL, 0);
        filler(buf, "pre", NULL, 0);
        if (te) filler(buf, "target", NULL, 0);
        return 0;
    }
    LOG("readdir %s -> ENOENT", path);
    return -ENOENT;
}

static int synth_open(const char *path, struct fuse_file_info *fi) {
    (void)fi;
    LOG("open %s", path);
    if (strcmp(path, "/dir/pre") == 0) return 0;
    if (strcmp(path, "/dir/target") == 0 && target_exists()) return 0;
    return -ENOENT;
}

static int synth_read(const char *path, char *buf, size_t size, off_t offset,
                      struct fuse_file_info *fi) {
    (void)fi;
    const char *data = NULL;
    if (strcmp(path, "/dir/pre") == 0) data = "pre";
    else if (strcmp(path, "/dir/target") == 0 && target_exists()) data = "target";
    else return -ENOENT;
    size_t len = strlen(data);
    if ((size_t)offset >= len) return 0;
    if (offset + size > len) size = len - offset;
    memcpy(buf, data + offset, size);
    LOG("read %s (%zu bytes)", path, size);
    return (int)size;
}

static struct fuse_operations synth_ops = {
    .getattr = synth_getattr,
    .readdir = synth_readdir,
    .open    = synth_open,
    .read    = synth_read,
};

int main(int argc, char *argv[]) {
    gettimeofday(&g_start, NULL);
    const char *aa = getenv("APPEAR_AT");
    if (aa) g_appear_at = atol(aa);
    const char *ae = getenv("APPEAR_EPOCH_MS");
    if (ae) g_appear_epoch_ms = atoll(ae);
    const char *bm = getenv("BUMP_MTIME");
    if (bm && strcmp(bm, "1") == 0) g_bump_mtime = 1;
    LOG("mount start epoch_ms=%lld appear_at=%lds appear_epoch_ms=%lld bump_mtime=%d",
        now_ms(), g_appear_at, g_appear_epoch_ms, g_bump_mtime);
    return fuse_main(argc, argv, &synth_ops, NULL);
}
