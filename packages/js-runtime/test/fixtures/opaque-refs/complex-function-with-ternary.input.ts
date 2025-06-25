import { cell } from "commontools";

const price = cell(100);
const discount = cell(20);
const pitance = cell(5);
const prime = cell(true);

// Function with complex expression including ternary
const total = price - (prime ? discount : pitance);