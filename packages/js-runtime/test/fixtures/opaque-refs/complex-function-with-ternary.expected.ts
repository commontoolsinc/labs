import { cell, derive } from "commontools";
const price = cell(100);
const discount = cell(20);
const pitance = cell(5);
const prime = cell(true);
// Function with complex expression including ternary
const total = commontools_1.derive({ price, prime, discount, pitance }, ({ price: _v1, prime: _v2, discount: _v3, pitance: _v4 }) => _v1 - (_v2 ? _v3 : _v4));