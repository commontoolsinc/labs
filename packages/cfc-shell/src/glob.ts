/**
 * Glob pattern matching for VFS
 *
 * Supports: *, ?, [...], **
 * Returns matching paths with joined labels of all traversed directories.
 */

import { VFS } from "./vfs.ts";
import { Label, Labeled, labels } from "./labels.ts";

/**
 * Expand a glob pattern against the VFS.
 * Returns matching paths with joined labels of all traversed directories.
 */
export function expandGlob(vfs: VFS, pattern: string): Labeled<string[]> {
  // Normalize the pattern
  const normalizedPattern = vfs.resolvePath(pattern);

  // Split pattern into segments
  const segments = normalizedPattern.split("/").filter((s) => s !== "");

  // Start from root
  const matches: string[] = [];
  const traversedLabels: Label[] = [];

  // Helper function to match recursively
  function matchSegments(
    currentPath: string,
    remainingSegments: string[],
    currentDepth: number,
  ): void {
    // Get current node
    const node = vfs.resolve(currentPath === "" ? "/" : currentPath, true);

    if (!node || node.kind !== "directory") {
      return;
    }

    // Track directory label
    traversedLabels.push(node.label);

    // Base case: no more segments
    if (remainingSegments.length === 0) {
      matches.push(currentPath === "" ? "/" : currentPath);
      return;
    }

    const [segment, ...rest] = remainingSegments;

    // Handle ** (globstar - matches zero or more directories)
    if (segment === "**") {
      // Match zero directories (skip the **)
      if (rest.length > 0) {
        matchSegments(currentPath, rest, currentDepth);
      } else {
        // ** at the end matches everything recursively
        matches.push(currentPath === "" ? "/" : currentPath);
      }

      // Match one or more directories
      for (const [childName, childNode] of node.children) {
        if (childNode.kind === "directory") {
          const childPath = currentPath === "" || currentPath === "/"
            ? "/" + childName
            : currentPath + "/" + childName;

          // Continue matching with ** (recursive)
          matchSegments(childPath, remainingSegments, currentDepth + 1);
        } else if (rest.length === 0) {
          // If ** is at the end, also match files
          const childPath = currentPath === "" || currentPath === "/"
            ? "/" + childName
            : currentPath + "/" + childName;
          matches.push(childPath);
        }
      }

      return;
    }

    // Regular segment matching
    for (const [childName, childNode] of node.children) {
      if (matchGlob(segment, childName)) {
        const childPath = currentPath === "" || currentPath === "/"
          ? "/" + childName
          : currentPath + "/" + childName;

        if (rest.length === 0) {
          // Last segment - add to matches
          matches.push(childPath);
        } else {
          // More segments - recurse
          if (childNode.kind === "directory") {
            matchSegments(childPath, rest, currentDepth + 1);
          }
        }
      }
    }
  }

  // Start matching from root
  matchSegments("", segments, 0);

  // Join all traversed directory labels
  const joinedLabel = labels.joinAll(traversedLabels);

  return {
    value: matches,
    label: joinedLabel,
  };
}

/**
 * Test if a filename matches a glob pattern (single segment, no /).
 * Supports: *, ?, [...]
 */
export function matchGlob(pattern: string, name: string): boolean {
  return matchGlobImpl(pattern, name, 0, 0);
}

function matchGlobImpl(
  pattern: string,
  name: string,
  pIdx: number,
  nIdx: number,
): boolean {
  // Both exhausted - match
  if (pIdx === pattern.length && nIdx === name.length) {
    return true;
  }

  // Pattern exhausted but name has more - no match
  if (pIdx === pattern.length) {
    return false;
  }

  // Name exhausted but pattern has more - check if remaining is all *
  if (nIdx === name.length) {
    for (let i = pIdx; i < pattern.length; i++) {
      if (pattern[i] !== "*") {
        return false;
      }
    }
    return true;
  }

  const pChar = pattern[pIdx];

  // Handle *
  if (pChar === "*") {
    // Try matching zero or more characters
    // Match zero characters
    if (matchGlobImpl(pattern, name, pIdx + 1, nIdx)) {
      return true;
    }

    // Match one or more characters
    for (let i = nIdx; i < name.length; i++) {
      if (matchGlobImpl(pattern, name, pIdx + 1, i + 1)) {
        return true;
      }
    }

    return false;
  }

  // Handle ?
  if (pChar === "?") {
    // Match any single character
    return matchGlobImpl(pattern, name, pIdx + 1, nIdx + 1);
  }

  // Handle [...]
  if (pChar === "[") {
    const closeIdx = pattern.indexOf("]", pIdx);
    if (closeIdx === -1) {
      // Malformed pattern - treat [ as literal
      return pattern[pIdx] === name[nIdx] &&
        matchGlobImpl(pattern, name, pIdx + 1, nIdx + 1);
    }

    const charClass = pattern.substring(pIdx + 1, closeIdx);
    const nChar = name[nIdx];

    if (matchCharClass(charClass, nChar)) {
      return matchGlobImpl(pattern, name, closeIdx + 1, nIdx + 1);
    }

    return false;
  }

  // Literal character
  if (pChar === name[nIdx]) {
    return matchGlobImpl(pattern, name, pIdx + 1, nIdx + 1);
  }

  return false;
}

function matchCharClass(charClass: string, char: string): boolean {
  // Handle negation
  let negated = false;
  let cls = charClass;

  if (cls.startsWith("!") || cls.startsWith("^")) {
    negated = true;
    cls = cls.substring(1);
  }

  // Check for ranges and individual characters
  let matches = false;

  for (let i = 0; i < cls.length; i++) {
    // Check for range (a-z)
    if (i + 2 < cls.length && cls[i + 1] === "-") {
      const start = cls[i];
      const end = cls[i + 2];

      if (char >= start && char <= end) {
        matches = true;
        break;
      }

      i += 2; // Skip the range
    } else {
      // Individual character
      if (cls[i] === char) {
        matches = true;
        break;
      }
    }
  }

  return negated ? !matches : matches;
}
