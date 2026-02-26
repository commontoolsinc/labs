// Cell Controller tests temporarily disabled for type checking.
// TODO(#ct-outliner): These tests need a CellHandle mock that passes isCellHandle() (which uses
// instanceof CellHandle). Plain-object mocks won't work. Same blocker as the
// ct-outliner tests that use Cell objects as stand-ins for CellHandle.
// See ct-outliner/ct-outliner.ts mutateCellHandle() doc comment for related context.

/*
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { LitElement } from "lit";
import {
  CellController,
  StringCellController,
  ArrayCellController,
  createCellController,
  createStringCellController,
  createArrayCellController
} from "./cell-controller.ts";

// Tests will be re-enabled once mock implementations are updated
*/

export {}; // Make this a valid module
