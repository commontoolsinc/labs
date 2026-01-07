/**
 * Type-level tests for Cell.focus()
 *
 * These tests verify that focus() has the same type inference as chaining .key() calls.
 * If the types are incorrect, these tests will fail to compile.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Cell, FocusResultType, AsCell } from "../src/builder/types.ts";

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
// FocusResultType type tests
// ============================================================================

// Empty keys should return the original type
type _Test1 = MustBeTrue<
  AssertEqual<FocusResultType<User, [], AsCell>, Cell<User>>
>;

// Single key should match KeyResultType behavior
type _Test2 = MustBeTrue<
  AssertEqual<FocusResultType<User, ["name"], AsCell>, Cell<string>>
>;

type _Test3 = MustBeTrue<
  AssertEqual<FocusResultType<User, ["age"], AsCell>, Cell<number>>
>;

type _Test4 = MustBeTrue<
  AssertEqual<
    FocusResultType<User, ["profile"], AsCell>,
    Cell<User["profile"]>
  >
>;

// Two keys
type _Test5 = MustBeTrue<
  AssertEqual<
    FocusResultType<User, ["profile", "bio"], AsCell>,
    Cell<string>
  >
>;

type _Test6 = MustBeTrue<
  AssertEqual<
    FocusResultType<User, ["profile", "settings"], AsCell>,
    Cell<User["profile"]["settings"]>
  >
>;

// Three keys
type _Test7 = MustBeTrue<
  AssertEqual<
    FocusResultType<User, ["profile", "settings", "theme"], AsCell>,
    Cell<"light" | "dark">
  >
>;

type _Test8 = MustBeTrue<
  AssertEqual<
    FocusResultType<User, ["profile", "settings", "notifications"], AsCell>,
    Cell<boolean>
  >
>;

// Array access
type _Test9 = MustBeTrue<
  AssertEqual<
    FocusResultType<User, ["posts", 0], AsCell>,
    Cell<User["posts"][0]>
  >
>;

type _Test10 = MustBeTrue<
  AssertEqual<
    FocusResultType<User, ["posts", 0, "title"], AsCell>,
    Cell<string>
  >
>;

// Unknown keys should fall back to Cell<any>
type _Test11 = MustBeTrue<
  AssertEqual<
    FocusResultType<User, ["unknownKey"], AsCell>,
    Cell<any>
  >
>;

type _Test12 = MustBeTrue<
  AssertEqual<
    FocusResultType<User, ["profile", "unknownKey"], AsCell>,
    Cell<any>
  >
>;

// ============================================================================
// Runtime tests (behavior verification)
// ============================================================================

describe("Cell.focus() types", () => {
  it("compiles with correct types - this test verifies the type assertions above", () => {
    // If this file compiles, the type tests pass
    // The type assertions above use MustBeTrue which would cause compile errors if wrong
    expect(true).toBe(true);
  });

  it("focus() with no keys should have same type as the cell", () => {
    // This is a compile-time check - if types are wrong, this won't compile
    const checkType = <T>(_cell: Cell<T>, _focused: Cell<T>) => {};
    const _useCheckType = (cell: Cell<User>) => {
      // @ts-expect-error - focus() with no args returns Cell<User>, not void
      const focused: void = cell.focus();
      // This should compile fine:
      checkType(cell, cell.focus());
    };
    expect(true).toBe(true);
  });

  it("focus() with one key matches key() type", () => {
    const checkSameType = <T>(_a: T, _b: T) => {};
    const _useCheckType = (cell: Cell<User>) => {
      // These should have the same type
      checkSameType(cell.key("name"), cell.focus("name"));
      checkSameType(cell.key("profile"), cell.focus("profile"));
      checkSameType(cell.key("posts"), cell.focus("posts"));
    };
    expect(true).toBe(true);
  });

  it("focus() with multiple keys matches chained key() type", () => {
    const checkSameType = <T>(_a: T, _b: T) => {};
    const _useCheckType = (cell: Cell<User>) => {
      // Two keys
      checkSameType(
        cell.key("profile").key("bio"),
        cell.focus("profile", "bio"),
      );

      // Three keys
      checkSameType(
        cell.key("profile").key("settings").key("theme"),
        cell.focus("profile", "settings", "theme"),
      );

      // Array access
      checkSameType(
        cell.key("posts").key(0).key("title"),
        cell.focus("posts", 0, "title"),
      );
    };
    expect(true).toBe(true);
  });

  it("focus() result can be used with Cell methods", () => {
    const _useCheckType = (cell: Cell<User>) => {
      // These should all compile and have correct return types
      const _name: Cell<string> = cell.focus("name");
      const _theme: Cell<"light" | "dark"> = cell.focus(
        "profile",
        "settings",
        "theme",
      );
      const _post: Cell<User["posts"][0]> = cell.focus("posts", 0);
    };
    expect(true).toBe(true);
  });
});
