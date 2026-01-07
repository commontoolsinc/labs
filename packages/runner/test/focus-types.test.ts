/**
 * Type-level tests for Cell.key() with multiple keys
 *
 * These tests verify that key() correctly handles multiple keys.
 * If the types are incorrect, these tests will fail to compile.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Cell, KeyResultType, AsCell } from "../src/builder/types.ts";

// ============================================================================
// Type-level assertions (compile-time checks)
// ============================================================================

/**
 * Helper type that asserts two types are equal.
 * If T and U are not the same, this produces `never`.
 */
type AssertEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never)
  : never;

/**
 * Helper to force a compile error if the type is not `true`.
 * Usage: const _check: MustBeTrue<AssertEqual<A, B>> = true;
 */
type MustBeTrue<T extends true> = T;

// Test data types
type User = {
  name: string;
  age: number;
  profile: {
    bio: string;
    avatar: string;
    settings: {
      theme: "light" | "dark";
      notifications: boolean;
    };
  };
  posts: Array<{
    id: number;
    title: string;
    content: string;
  }>;
};

// ============================================================================
// KeyResultType type tests
// ============================================================================

// Empty keys should return the original type
type _Test1 = MustBeTrue<
  AssertEqual<KeyResultType<User, [], AsCell>, Cell<User>>
>;

// Single key
type _Test2 = MustBeTrue<
  AssertEqual<KeyResultType<User, ["name"], AsCell>, Cell<string>>
>;

type _Test3 = MustBeTrue<
  AssertEqual<KeyResultType<User, ["age"], AsCell>, Cell<number>>
>;

type _Test4 = MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["profile"], AsCell>,
    Cell<User["profile"]>
  >
>;

// Two keys
type _Test5 = MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["profile", "bio"], AsCell>,
    Cell<string>
  >
>;

type _Test6 = MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["profile", "settings"], AsCell>,
    Cell<User["profile"]["settings"]>
  >
>;

// Three keys
type _Test7 = MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["profile", "settings", "theme"], AsCell>,
    Cell<"light" | "dark">
  >
>;

type _Test8 = MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["profile", "settings", "notifications"], AsCell>,
    Cell<boolean>
  >
>;

// Array access
type _Test9 = MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["posts", 0], AsCell>,
    Cell<User["posts"][0]>
  >
>;

type _Test10 = MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["posts", 0, "title"], AsCell>,
    Cell<string>
  >
>;

// Unknown keys should fall back to Cell<any>
type _Test11 = MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["unknownKey"], AsCell>,
    Cell<any>
  >
>;

type _Test12 = MustBeTrue<
  AssertEqual<
    KeyResultType<User, ["profile", "unknownKey"], AsCell>,
    Cell<any>
  >
>;

// ============================================================================
// Runtime tests (behavior verification)
// ============================================================================

describe("Cell.key() with multiple keys", () => {
  it("compiles with correct types - this test verifies the type assertions above", () => {
    // If this file compiles, the type tests pass
    // The type assertions above use MustBeTrue which would cause compile errors if wrong
    expect(true).toBe(true);
  });

  it("key() with no keys should have same type as the cell", () => {
    // This is a compile-time check - if types are wrong, this won't compile
    const checkType = <T>(_cell: Cell<T>, _keyed: Cell<T>) => {};
    const _useCheckType = (cell: Cell<User>) => {
      // @ts-expect-error - key() with no args returns Cell<User>, not void
      const keyed: void = cell.key();
      // This should compile fine:
      checkType(cell, cell.key());
    };
    expect(true).toBe(true);
  });

  it("key() with multiple keys works", () => {
    const _useCheckType = (cell: Cell<User>) => {
      // Single key
      const _name: Cell<string> = cell.key("name");

      // Two keys
      const _bio: Cell<string> = cell.key("profile", "bio");

      // Three keys
      const _theme: Cell<"light" | "dark"> = cell.key(
        "profile",
        "settings",
        "theme",
      );

      // Array access
      const _post: Cell<User["posts"][0]> = cell.key("posts", 0);
      const _title: Cell<string> = cell.key("posts", 0, "title");
    };
    expect(true).toBe(true);
  });
});
