/**
 * Decodes raw terminal bytes into normalised {@link Key} events.
 *
 * Pure and incremental: {@link decodeKeys} returns the keys it could fully
 * parse plus any trailing bytes that form an incomplete escape sequence, which
 * the caller prepends to the next read. A lone ESC at the end of a read is
 * emitted as Escape immediately (local terminals deliver `ESC [ A` arrows in a
 * single read, so a solitary ESC means the Escape key) — this keeps Escape
 * responsive at the cost of mis-handling escape sequences split across reads,
 * which does not happen for local TTY input.
 */

export interface Key {
  /**
   * Normalised name: an arrow/nav name ("up", "down", "left", "right",
   * "pageup", "pagedown", "home", "end"), a function key ("f1".."f12"), an
   * editing name ("enter", "escape", "backspace", "delete", "tab", "space"), a
   * control combo ("ctrl-c", "ctrl-d", …), or the literal character for a
   * printable key ("a", "/", "?").
   */
  readonly name: string;
  readonly ctrl?: boolean;
  /** Alt/Meta modifier (from `ESC <key>` or a CSI modifier param). For an
   * Alt+letter, `name` is the letter and `char` is unset. */
  readonly alt?: boolean;
  readonly shift?: boolean;
  /** The printable character, when the key produced one. */
  readonly char?: string;
}

export interface DecodeResult {
  readonly keys: Key[];
  readonly rest: Uint8Array;
}

export function decodeKeys(buf: Uint8Array): DecodeResult {
  const keys: Key[] = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];

    if (b === 0x1b) {
      if (i + 1 >= buf.length) {
        keys.push({ name: "escape" });
        i += 1;
        continue;
      }
      const n = buf[i + 1];
      if (n === 0x4f) { // SS3: ESC O <final>
        if (i + 2 >= buf.length) break;
        keys.push(ss3ToKey(buf[i + 2]));
        i += 3;
        continue;
      }
      if (n === 0x5b) { // CSI: ESC [ <params> <final>
        let j = i + 2;
        let params = "";
        while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x3f) {
          params += String.fromCharCode(buf[j]);
          j += 1;
        }
        if (j >= buf.length) break; // final byte not arrived yet
        keys.push(csiToKey(buf[j], params));
        i = j + 1;
        continue;
      }
      // ESC ESC: a real Escape (or a doubled meta prefix); emit Escape.
      if (n === 0x1b) {
        keys.push({ name: "escape" });
        i += 1;
        continue;
      }
      // Meta/Alt: `ESC <key>` is Alt+key. Backspace → alt-backspace
      // (backward-kill-word); a control byte → ctrl with alt; a printable byte
      // → the letter with `alt`.
      if (n === 0x7f || n === 0x08) {
        keys.push({ name: "backspace", alt: true });
        i += 2;
        continue;
      }
      if (n < 0x20) {
        keys.push({
          name: `ctrl-${String.fromCharCode(n + 96)}`,
          ctrl: true,
          alt: true,
        });
        i += 2;
        continue;
      }
      if (n < 0x80) {
        const ch = String.fromCharCode(n);
        keys.push({ name: ch, alt: true });
        i += 2;
        continue;
      }
      // ESC followed by a high byte we do not model: treat the ESC as Escape.
      keys.push({ name: "escape" });
      i += 1;
      continue;
    }

    if (b === 0x0d || b === 0x0a) {
      keys.push({ name: "enter" });
      i += 1;
    } else if (b === 0x09) {
      keys.push({ name: "tab" });
      i += 1;
    } else if (b === 0x7f || b === 0x08) {
      keys.push({ name: "backspace" });
      i += 1;
    } else if (b === 0x03) {
      keys.push({ name: "ctrl-c", ctrl: true });
      i += 1;
    } else if (b < 0x20) {
      keys.push({ name: `ctrl-${String.fromCharCode(b + 96)}`, ctrl: true });
      i += 1;
    } else if (b === 0x20) {
      keys.push({ name: "space", char: " " });
      i += 1;
    } else if (b < 0x80) {
      const ch = String.fromCharCode(b);
      keys.push({ name: ch, char: ch });
      i += 1;
    } else {
      let j = i + 1;
      while (j < buf.length && (buf[j] & 0xc0) === 0x80) j += 1;
      const ch = new TextDecoder().decode(buf.slice(i, j));
      keys.push({ name: ch, char: ch });
      i = j;
    }
  }
  return { keys, rest: buf.slice(i) };
}

/** Decode the `1;<m>` modifier suffix of a CSI sequence: m-1 is a bitmask of
 * shift(1)/alt(2)/ctrl(4). */
function modifiers(params: string): {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
} {
  const parts = params.split(";");
  const m = parts.length > 1 ? parseInt(parts[1], 10) : 0;
  if (!m || m < 2) return {};
  const bits = m - 1;
  const out: { shift?: boolean; alt?: boolean; ctrl?: boolean } = {};
  if (bits & 1) out.shift = true;
  if (bits & 2) out.alt = true;
  if (bits & 4) out.ctrl = true;
  return out;
}

function csiToKey(final: number, params: string): Key {
  const mods = modifiers(params);
  switch (final) {
    case 0x41:
      return { name: "up", ...mods };
    case 0x42:
      return { name: "down", ...mods };
    case 0x43:
      return { name: "right", ...mods };
    case 0x44:
      return { name: "left", ...mods };
    case 0x48:
      return { name: "home", ...mods };
    case 0x46:
      return { name: "end", ...mods };
    case 0x5a: // ESC [ Z
      return { name: "shift-tab" };
    case 0x50: // ESC [ P  (some terminals)
      return { name: "f1" };
    case 0x51:
      return { name: "f2" };
    case 0x52:
      return { name: "f3" };
    case 0x53:
      return { name: "f4" };
    case 0x7e:
      return tildeKey(params);
    default:
      return { name: "unknown" };
  }
}

function tildeKey(params: string): Key {
  const code = parseInt(params.split(";")[0] || "0", 10);
  const mods = modifiers(params);
  switch (code) {
    case 1:
    case 7:
      return { name: "home", ...mods };
    case 4:
    case 8:
      return { name: "end", ...mods };
    case 3:
      return { name: "delete", ...mods };
    case 5:
      return { name: "pageup", ...mods };
    case 6:
      return { name: "pagedown", ...mods };
    case 11:
      return { name: "f1" };
    case 12:
      return { name: "f2" };
    case 13:
      return { name: "f3" };
    case 14:
      return { name: "f4" };
    case 15:
      return { name: "f5" };
    case 17:
      return { name: "f6" };
    case 18:
      return { name: "f7" };
    case 19:
      return { name: "f8" };
    case 20:
      return { name: "f9" };
    case 21:
      return { name: "f10" };
    case 23:
      return { name: "f11" };
    case 24:
      return { name: "f12" };
    default:
      return { name: "unknown" };
  }
}

function ss3ToKey(final: number): Key {
  switch (final) {
    case 0x41:
      return { name: "up" };
    case 0x42:
      return { name: "down" };
    case 0x43:
      return { name: "right" };
    case 0x44:
      return { name: "left" };
    case 0x48:
      return { name: "home" };
    case 0x46:
      return { name: "end" };
    case 0x50: // ESC O P
      return { name: "f1" };
    case 0x51:
      return { name: "f2" };
    case 0x52: // ESC O R — F3 (xterm/macOS Terminal)
      return { name: "f3" };
    case 0x53:
      return { name: "f4" };
    default:
      return { name: "unknown" };
  }
}
