/// <cts-enable />
import { cell, recipe, handler } from "commontools";

// 1. Top-level
const _topLevel = cell(10);

// 2. Inside function
function regularFunction() {
  const _inFunction = cell(20);
  return _inFunction;
}

// 3. Inside arrow function
const arrowFunction = () => {
  const _inArrow = cell(30);
  return _inArrow;
};

// 4. Inside class method
class TestClass {
  method() {
    const _inMethod = cell(40);
    return _inMethod;
  }
}

// 5. Inside recipe
const testRecipe = recipe(() => {
  const _inRecipe = cell(50);
  return _inRecipe;
});

// 6. Inside handler
const testHandler = handler(() => {
  const _inHandler = cell(60);
  return _inHandler;
});

export default function TestContextVariations() {
  return {
    topLevel: _topLevel,
    regularFunction,
    arrowFunction,
    TestClass,
    testRecipe,
    testHandler,
  };
}
