import { cell, derive } from "@commontools/common";
const a = cell(5);
const b = cell(10);
// Function calls with OpaqueRef arguments
const max1 = derive(a, _v1 => Math.max(_v1, 10));
const max2 = derive({ a, b }, ({ a: _v1, b: _v2 }) => Math.max(_v1, _v2));
const max3 = Math.max(a.get(), 20);
// Custom function calls
function someFunction(x: number, prefix: string): string {
    return prefix + x;
}
const result1 = derive(a, _v1 => someFunction(_v1 + 1, "prefix"));
const result2 = someFunction(a.get() + b.get(), "sum");
const result3 = derive(a, _v1 => someFunction(_v1 * 2, "double"));
// Function calls with mixed arguments
function complexFunction(a: number, b: string, c: boolean): void {
    console.log(a, b, c);
}
derive(a, _v1 => complexFunction(_v1 + 5, "test", true));
derive({ b_get: b.get, a }, ({ b_get: _v1, a: _v2 }) => complexFunction(_v1(), `value: ${_v2}`, false));
// Array methods with OpaqueRef
const arr = [1, 2, 3];
const index = cell(1);
const element = arr[index.get()];
const sliced = derive(a, _v1 => arr.slice(0, _v1));
// Object method calls
const obj = {
    method(x: number): number {
        return x * 2;
    }
};
const methodResult = derive(a, _v1 => obj.method(_v1));
