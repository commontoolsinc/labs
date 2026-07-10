#!/usr/bin/env python3
# Drives stat/readdir against the synthfs mount. argv[3] is an ABSOLUTE
# appear-epoch in ms, shared with the C fs, so both agree on when the file
# begins to exist (no cross-process clock skew).
import os, sys, time

def ms(): return int(time.time() * 1000)

def stat_target(path):
    try:
        os.stat(path); return True
    except FileNotFoundError:
        return False

def main():
    mode            = sys.argv[1]
    mnt             = sys.argv[2]
    appear_epoch_ms = int(sys.argv[3])
    tgt = os.path.join(mnt, "dir", "target")
    d   = os.path.join(mnt, "dir")
    t0 = time.time()
    def el(): return time.time() - t0
    def appeared(): return ms() >= appear_epoch_ms
    def secs_after_appear(): return (ms() - appear_epoch_ms) / 1000.0
    def wait_for_appear():
        while not appeared(): time.sleep(0.05)

    print(f"DRIVER {ms()} mode={mode} appear_epoch_ms={appear_epoch_ms} "
          f"(in {(appear_epoch_ms-ms())/1000.0:.1f}s)", flush=True)

    if mode in ("arm_a", "arm_b"):
        # Seed a negative NAME-cache entry by stat-ing the absent target.
        while not appeared() and el() < 6:
            ok = stat_target(tgt)
            print(f"SEED {ms()} el={el():.2f} appeared={appeared()} "
                  f"stat_target={'OK' if ok else 'ENOENT'}", flush=True)
            time.sleep(0.5)
        wait_for_appear(); time.sleep(0.2)
        print(f"APPEARED {ms()} (target now exists daemon-side)", flush=True)

    if mode == "arm_a":
        t_deadline = time.time() + 90; first = None
        while time.time() < t_deadline:
            ok = stat_target(tgt)
            print(f"POLL {ms()} after_appear={secs_after_appear():.2f} "
                  f"stat_target={'OK' if ok else 'ENOENT'}", flush=True)
            if ok: first = secs_after_appear(); break
            time.sleep(0.5)
        print(f"RESULT stale_window_s={'UNRESOLVED(>90)' if first is None else f'{first:.2f}'}", flush=True)

    elif mode == "arm_b":
        for i in range(3):
            ok = stat_target(tgt)
            print(f"PRE_LS {ms()} after_appear={secs_after_appear():.2f} "
                  f"stat_target={'OK' if ok else 'ENOENT'}", flush=True)
            time.sleep(0.5)
        names = sorted(os.listdir(d))
        print(f"LISTDIR {ms()} after_appear={secs_after_appear():.2f} names={names} "
              f"target_in_listing={'target' in names}", flush=True)
        for i in range(6):
            ok = stat_target(tgt)
            print(f"POST_LS {ms()} after_appear={secs_after_appear():.2f} "
                  f"stat_target={'OK' if ok else 'ENOENT'}", flush=True)
            if ok: print(f"RESULT post_ls_first_ok_after_appear={secs_after_appear():.2f}", flush=True); break
            time.sleep(0.2)
        else:
            print("RESULT post_ls=STILL_ENOENT", flush=True)

    elif mode == "arm_f":
        # True E4 race. Order matters:
        #  1) ONE listdir -> caches a STALE listing (['pre']) and starts its
        #     ~acdirmin validity clock.
        #  2) stat(target) -> seeds a negative name entry AFTER that readdir, so
        #     it persists; keep it alive with pure stats (NO more readdir).
        #  3) target appears; a short gap keeps us inside the stale listing's
        #     validity window.
        #  4) single readdir fallback: is it served the stale cached listing?
        gap = float(os.environ.get("GAP", "1"))
        names0 = sorted(os.listdir(d))               # (1) stale listing cache load
        print(f"INIT_LS {ms()} el={el():.2f} names={names0}", flush=True)
        ok = stat_target(tgt)                         # (2) seed negative entry
        print(f"SEED_STAT {ms()} el={el():.2f} stat={'OK' if ok else 'ENOENT'}", flush=True)
        # pure-stat keep-alive until appear (no readdir!)
        while not appeared():
            stat_target(tgt); time.sleep(0.3)
        time.sleep(gap)                               # (3) stay inside validity window
        listing_age = el()
        ok = stat_target(tgt)                         # PR step 1
        print(f"PR_STAT {ms()} after_appear={secs_after_appear():.2f} listing_age~={listing_age:.2f}s "
              f"stat={'OK' if ok else 'ENOENT'}", flush=True)
        if ok:
            print(f"RESULT arm_f gap={gap} outcome=RESOLVED_VIA_STAT", flush=True)
        else:
            names = sorted(os.listdir(d))             # PR step 2: the fallback readdir
            hit = "target" in names
            print(f"PR_READDIR {ms()} after_appear={secs_after_appear():.2f} names={names} target_present={hit}", flush=True)
            print(f"RESULT arm_f gap={gap} outcome={'RESOLVED_VIA_READDIR' if hit else 'FALSE_ENOENT (PR FALLBACK FAILS — stale listing served)'}", flush=True)

    elif mode == "arm_e":
        # Precise cf-exec pattern. Seed both caches, then go QUIET (no fs
        # activity) so neither cache is refreshed, then after appear + GAP do the
        # PR fallback exactly ONCE: stat; on ENOENT a single readdir. Reports
        # whether that one readdir was fresh (target present) or stale.
        gap = float(os.environ.get("GAP", "3"))
        for i in range(3):
            ok = stat_target(tgt); names0 = sorted(os.listdir(d))
            print(f"SEED {ms()} el={el():.2f} stat={'OK' if ok else 'ENOENT'} names={names0}", flush=True)
            time.sleep(0.4)
        wait_for_appear()
        # QUIET gap: no fs syscalls at all, just sleep.
        time.sleep(gap)
        print(f"PROBE_START {ms()} after_appear={secs_after_appear():.2f} gap={gap}", flush=True)
        ok = stat_target(tgt)                             # PR step 1 (single)
        print(f"PR_STAT {ms()} after_appear={secs_after_appear():.2f} stat={'OK' if ok else 'ENOENT'}", flush=True)
        if ok:
            print(f"RESULT arm_e gap={gap} outcome=RESOLVED_VIA_STAT (neg-cache expired or absent)", flush=True)
        else:
            names = sorted(os.listdir(d))                 # PR step 2 (single readdir)
            hit = "target" in names
            print(f"PR_READDIR {ms()} after_appear={secs_after_appear():.2f} names={names} target_present={hit}", flush=True)
            print(f"RESULT arm_e gap={gap} outcome={'RESOLVED_VIA_READDIR' if hit else 'FALSE_ENOENT (PR FALLBACK FAILS — stale listing)'}", flush=True)

    elif mode == "arm_d":
        # E4 worst case: seed BOTH a negative name-cache entry (stat) AND a
        # stale directory-listing cache (listdir) before target exists, then run
        # the PR's exact fallback. Does the readdir fallback return a stale
        # listing (missing target), producing a false ENOENT with no retry?
        primes = 0
        while not appeared() and el() < 20:
            ok = stat_target(tgt)
            names0 = sorted(os.listdir(d)); primes += 1
            if primes <= 2:
                print(f"PRIME {ms()} el={el():.2f} stat={'OK' if ok else 'ENOENT'} "
                      f"names={names0}", flush=True)
            time.sleep(0.5)
        time.sleep(0.2)
        print(f"APPEARED {ms()} (target now exists daemon-side) primes={primes}", flush=True)
        t_deadline = time.time() + 90; first = None
        while time.time() < t_deadline:
            ok = stat_target(tgt)                        # PR step 1
            via = "stat" if ok else None
            names = None
            if not ok:
                names = sorted(os.listdir(d))            # PR step 2: readdir fallback
                if "target" in names: via = "readdir"
            print(f"PRFALLBACK {ms()} after_appear={secs_after_appear():.2f} "
                  f"stat={'OK' if ok else 'ENOENT'} listing={names} "
                  f"resolves={'YES' if via else 'NO'} via={via}", flush=True)
            if via: first = (secs_after_appear(), via); break
            time.sleep(1.0)
        if first is None:
            print("RESULT arm_d=UNRESOLVED(>90) — PR FALLBACK FAILS", flush=True)
        else:
            print(f"RESULT arm_d_resolved_after_appear_s={first[0]:.2f} via={first[1]}", flush=True)

    elif mode == "arm_c":
        # E4: cache the PARENT LISTING repeatedly *before* target exists, then
        # after it appears run the PR's exact fallback (stat; on ENOENT readdir)
        # and see whether the readdir keeps returning a stale listing.
        primes = 0
        while not appeared():
            names0 = sorted(os.listdir(d)); primes += 1
            if primes <= 2 or appeared():
                print(f"PRIME_LS {ms()} el={el():.2f} names={names0} appeared={appeared()}", flush=True)
            time.sleep(0.5)
        time.sleep(0.2)
        print(f"APPEARED {ms()} (target now exists daemon-side) primes={primes}", flush=True)
        t_deadline = time.time() + 90; first = None
        while time.time() < t_deadline:
            ok = stat_target(tgt)                        # PR step 1
            via = "stat" if ok else None
            names = None
            if not ok:
                names = sorted(os.listdir(d))            # PR step 2: readdir fallback
                if "target" in names: via = "readdir"
            print(f"PRFALLBACK {ms()} after_appear={secs_after_appear():.2f} "
                  f"stat={'OK' if ok else 'ENOENT'} listing={names} "
                  f"resolves={'YES' if via else 'NO'} via={via}", flush=True)
            if via: first = (secs_after_appear(), via); break
            time.sleep(1.0)
        if first is None:
            print("RESULT arm_c=UNRESOLVED(>90)", flush=True)
        else:
            print(f"RESULT arm_c_resolved_after_appear_s={first[0]:.2f} via={first[1]}", flush=True)

if __name__ == "__main__":
    main()
