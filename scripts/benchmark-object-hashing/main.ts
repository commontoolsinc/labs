#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env

/**
 * Benchmark for comparing object hashing strategies.
 *
 * Compares merkle-reference against various alternatives for stable object hashing.
 * Tests different hash functions with merkle-reference and evaluates performance
 * across various data structures.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-env scripts/benchmark-object-hashing.ts
 */

// Import libraries from esm.sh to avoid adding dependencies
// @ts-ignore - dynamic import from esm.sh
const MerkleReference = await import("https://esm.sh/merkle-reference@2.2.0");
// @ts-ignore - dynamic import from esm.sh
const objectHash = await import("https://esm.sh/object-hash@3.0.0");
// @ts-ignore - dynamic import from esm.sh
const hashIt = await import("https://esm.sh/hash-it@6.0.0");
// @ts-ignore - dynamic import from esm.sh
const fastStableStringify = await import(
  "https://esm.sh/fast-json-stable-stringify@2.1.0"
);
// @ts-ignore - dynamic import from esm.sh
const safeStableStringify = await import(
  "https://esm.sh/safe-stable-stringify@2.5.0"
);
// @ts-ignore - dynamic import from esm.sh
const { sha256 } = await import("https://esm.sh/@noble/hashes@1.4.0/sha256");
// @ts-ignore - dynamic import from esm.sh
const { blake2b } = await import(
  "https://esm.sh/@noble/hashes@1.4.0/blake2b"
);
// Create a 256-bit blake2b hasher
const blake2b256 = (data: Uint8Array) => blake2b(data, { dkLen: 32 });
// @ts-ignore - dynamic import from esm.sh
const { blake3 } = await import("https://esm.sh/@noble/hashes@1.4.0/blake3");
// @ts-ignore - dynamic import from esm.sh
const { createSHA256, createBLAKE3 } = await import(
  "https://esm.sh/hash-wasm@4.11.0"
);
// @ts-ignore - dynamic import from esm.sh
const dagCbor = await import("https://esm.sh/@ipld/dag-cbor@9.2.1");
// @ts-ignore - dynamic import from esm.sh
const { CID } = await import("https://esm.sh/multiformats@13.3.2/cid");
// @ts-ignore - dynamic import from esm.sh
const multihash = await import(
  "https://esm.sh/multiformats@13.3.2/hashes/digest"
);

// Test data structures
const testData = {
  // Small structures
  small: {
    simple: { a: 1, b: 2, c: 3 },
    nested: { a: { b: { c: 1 } } },
    array: [1, 2, 3, 4, 5],
    mixed: { a: [1, 2], b: { c: 3 }, d: "hello" },
  },

  // Large structures
  large: {
    // Wide object (many properties)
    wide: Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`key${i}`, i]),
    ),

    // Deep nesting
    deep: (() => {
      let obj: any = { value: "bottom" };
      for (let i = 0; i < 100; i++) {
        obj = { nested: obj };
      }
      return obj;
    })(),

    // Large array
    largeArray: Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `item${i}`,
      value: Math.random(),
    })),

    // Sparse array
    sparse: (() => {
      const arr = new Array(1000);
      arr[0] = "first";
      arr[100] = "middle";
      arr[999] = "last";
      return arr;
    })(),

    // Complex nested structure
    complex: {
      users: Array.from({ length: 100 }, (_, i) => ({
        id: i,
        name: `user${i}`,
        profile: {
          age: 20 + (i % 50),
          tags: [`tag${i % 10}`, `tag${(i + 1) % 10}`],
          settings: {
            theme: i % 2 === 0 ? "dark" : "light",
            notifications: i % 3 === 0,
          },
        },
      })),
      metadata: {
        version: "1.0.0",
        timestamp: Date.now(),
        count: 100,
      },
    },
  },

  // VDOM-like structures (simulating complex UI)
  vdom: {
    // Simple component
    simpleComponent: {
      type: "div",
      props: {
        className: "container mx-auto p-4",
        style: { display: "flex", flexDirection: "column" },
      },
      children: [
        {
          type: "h1",
          props: { className: "text-2xl font-bold" },
          children: ["Hello World"],
        },
        {
          type: "p",
          props: { className: "text-gray-600" },
          children: ["Welcome to our app"],
        },
      ],
    },

    // Form with inputs (typical form component)
    formComponent: {
      type: "form",
      props: {
        className: "space-y-4",
        onSubmit: "handleSubmit",
        method: "POST",
      },
      children: Array.from({ length: 20 }, (_, i) => ({
        type: "div",
        props: { className: "form-group" },
        children: [
          {
            type: "label",
            props: {
              htmlFor: `field-${i}`,
              className: "block text-sm font-medium",
            },
            children: [`Field ${i}`],
          },
          {
            type: "input",
            props: {
              type: i % 3 === 0 ? "email" : i % 3 === 1 ? "password" : "text",
              id: `field-${i}`,
              name: `field_${i}`,
              className: "mt-1 block w-full rounded-md border-gray-300",
              placeholder: `Enter field ${i}`,
              required: i < 5,
              disabled: false,
              autoComplete: i % 2 === 0 ? "on" : "off",
            },
            children: [],
          },
        ],
      })),
    },

    // Data table (common UI pattern)
    dataTable: {
      type: "table",
      props: { className: "min-w-full divide-y divide-gray-200" },
      children: [
        {
          type: "thead",
          props: { className: "bg-gray-50" },
          children: [{
            type: "tr",
            props: {},
            children: ["ID", "Name", "Email", "Role", "Status", "Actions"].map(
              (h) => ({
                type: "th",
                props: {
                  className:
                    "px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase",
                },
                children: [h],
              }),
            ),
          }],
        },
        {
          type: "tbody",
          props: { className: "bg-white divide-y divide-gray-200" },
          children: Array.from({ length: 100 }, (_, i) => ({
            type: "tr",
            props: {
              key: `row-${i}`,
              className: i % 2 === 0 ? "bg-white" : "bg-gray-50",
            },
            children: [
              {
                type: "td",
                props: { className: "px-6 py-4 whitespace-nowrap" },
                children: [String(i + 1)],
              },
              {
                type: "td",
                props: { className: "px-6 py-4 whitespace-nowrap" },
                children: [`User ${i}`],
              },
              {
                type: "td",
                props: { className: "px-6 py-4 whitespace-nowrap" },
                children: [`user${i}@example.com`],
              },
              {
                type: "td",
                props: { className: "px-6 py-4 whitespace-nowrap" },
                children: [i % 3 === 0 ? "Admin" : "User"],
              },
              {
                type: "span",
                props: {
                  className: `px-2 py-1 rounded-full text-xs ${
                    i % 4 === 0
                      ? "bg-green-100 text-green-800"
                      : "bg-gray-100 text-gray-800"
                  }`,
                },
                children: [i % 4 === 0 ? "Active" : "Inactive"],
              },
              {
                type: "div",
                props: { className: "flex space-x-2" },
                children: [
                  {
                    type: "button",
                    props: {
                      className: "text-blue-600 hover:text-blue-800",
                      onClick: `edit(${i})`,
                    },
                    children: ["Edit"],
                  },
                  {
                    type: "button",
                    props: {
                      className: "text-red-600 hover:text-red-800",
                      onClick: `delete(${i})`,
                    },
                    children: ["Delete"],
                  },
                ],
              },
            ],
          })),
        },
      ],
    },

    // Complex dashboard layout (deeply nested, many components)
    dashboard: (() => {
      const createCard = (title: string, content: any) => ({
        type: "div",
        props: { className: "bg-white rounded-lg shadow p-6" },
        children: [
          {
            type: "h3",
            props: { className: "text-lg font-semibold mb-4" },
            children: [title],
          },
          content,
        ],
      });

      const createChart = (id: string) => ({
        type: "div",
        props: { className: "chart-container", id, style: { height: 300 } },
        children: Array.from({ length: 30 }, (_) => ({
          type: "div",
          props: {
            className: "bar",
            style: { height: `${Math.random() * 100}%`, width: "3%" },
            "data-value": Math.floor(Math.random() * 1000),
          },
          children: [],
        })),
      });

      const createSidebar = () => ({
        type: "nav",
        props: { className: "w-64 bg-gray-800 min-h-screen p-4" },
        children: Array.from({ length: 15 }, (_, i) => ({
          type: "a",
          props: {
            href: `/section/${i}`,
            className:
              "flex items-center px-4 py-2 text-gray-300 hover:bg-gray-700 rounded",
          },
          children: [
            {
              type: "svg",
              props: { className: "w-5 h-5 mr-3", viewBox: "0 0 20 20" },
              children: [],
            },
            { type: "span", props: {}, children: [`Menu Item ${i + 1}`] },
          ],
        })),
      });

      return {
        type: "div",
        props: { className: "flex min-h-screen bg-gray-100" },
        children: [
          createSidebar(),
          {
            type: "main",
            props: { className: "flex-1 p-8" },
            children: [
              {
                type: "header",
                props: { className: "mb-8" },
                children: [
                  {
                    type: "h1",
                    props: { className: "text-3xl font-bold" },
                    children: ["Dashboard"],
                  },
                  {
                    type: "div",
                    props: { className: "flex space-x-4 mt-4" },
                    children: Array.from({ length: 4 }, (_, i) => ({
                      type: "div",
                      props: {
                        className: "bg-white rounded-lg shadow p-4 flex-1",
                      },
                      children: [
                        {
                          type: "p",
                          props: { className: "text-gray-500 text-sm" },
                          children: [`Metric ${i + 1}`],
                        },
                        {
                          type: "p",
                          props: { className: "text-2xl font-bold" },
                          children: [String(Math.floor(Math.random() * 10000))],
                        },
                      ],
                    })),
                  },
                ],
              },
              {
                type: "div",
                props: { className: "grid grid-cols-2 gap-6" },
                children: [
                  createCard("Revenue Chart", createChart("revenue")),
                  createCard("User Growth", createChart("users")),
                  createCard("Activity Feed", {
                    type: "ul",
                    props: { className: "space-y-3" },
                    children: Array.from({ length: 20 }, (_, i) => ({
                      type: "li",
                      props: {
                        className:
                          "flex items-center space-x-3 p-2 hover:bg-gray-50 rounded",
                      },
                      children: [
                        {
                          type: "div",
                          props: {
                            className: "w-8 h-8 rounded-full bg-blue-500",
                          },
                          children: [],
                        },
                        {
                          type: "div",
                          props: {},
                          children: [
                            {
                              type: "p",
                              props: { className: "text-sm font-medium" },
                              children: [`User ${i} performed action`],
                            },
                            {
                              type: "p",
                              props: { className: "text-xs text-gray-500" },
                              children: [`${i + 1} minutes ago`],
                            },
                          ],
                        },
                      ],
                    })),
                  }),
                  createCard("Recent Orders", {
                    type: "table",
                    props: { className: "w-full" },
                    children: Array.from({ length: 10 }, (_, i) => ({
                      type: "tr",
                      props: { className: "border-b" },
                      children: [
                        {
                          type: "td",
                          props: { className: "py-2" },
                          children: [`#${1000 + i}`],
                        },
                        {
                          type: "td",
                          props: { className: "py-2" },
                          children: [`$${(Math.random() * 500).toFixed(2)}`],
                        },
                        {
                          type: "td",
                          props: { className: "py-2" },
                          children: [i % 3 === 0 ? "Completed" : "Pending"],
                        },
                      ],
                    })),
                  }),
                ],
              },
            ],
          },
        ],
      };
    })(),

    // Full page app (very complex, simulates entire SPA)
    fullPageApp: (() => {
      const createNavbar = () => ({
        type: "nav",
        props: { className: "bg-white shadow-lg fixed w-full z-50" },
        children: [{
          type: "div",
          props: { className: "max-w-7xl mx-auto px-4" },
          children: [{
            type: "div",
            props: { className: "flex justify-between h-16" },
            children: [
              {
                type: "div",
                props: { className: "flex items-center" },
                children: [
                  {
                    type: "img",
                    props: { src: "/logo.svg", className: "h-8 w-8" },
                    children: [],
                  },
                  {
                    type: "span",
                    props: { className: "ml-2 text-xl font-bold" },
                    children: ["MyApp"],
                  },
                ],
              },
              {
                type: "div",
                props: { className: "flex items-center space-x-4" },
                children: ["Home", "Features", "Pricing", "About", "Contact"]
                  .map((item) => ({
                    type: "a",
                    props: {
                      href: `/${item.toLowerCase()}`,
                      className: "text-gray-600 hover:text-gray-900",
                    },
                    children: [item],
                  })),
              },
              {
                type: "div",
                props: { className: "flex items-center space-x-2" },
                children: [
                  {
                    type: "button",
                    props: { className: "px-4 py-2 text-gray-600" },
                    children: ["Login"],
                  },
                  {
                    type: "button",
                    props: {
                      className: "px-4 py-2 bg-blue-600 text-white rounded-lg",
                    },
                    children: ["Sign Up"],
                  },
                ],
              },
            ],
          }],
        }],
      });

      const createHeroSection = () => ({
        type: "section",
        props: {
          className: "pt-24 pb-12 bg-gradient-to-r from-blue-500 to-purple-600",
        },
        children: [{
          type: "div",
          props: { className: "max-w-7xl mx-auto px-4 text-center text-white" },
          children: [
            {
              type: "h1",
              props: { className: "text-5xl font-bold mb-6" },
              children: ["Build Amazing Products"],
            },
            {
              type: "p",
              props: { className: "text-xl mb-8 opacity-90" },
              children: ["The all-in-one platform for modern teams"],
            },
            {
              type: "div",
              props: { className: "flex justify-center space-x-4" },
              children: [
                {
                  type: "button",
                  props: {
                    className:
                      "px-8 py-3 bg-white text-blue-600 rounded-lg font-semibold",
                  },
                  children: ["Get Started"],
                },
                {
                  type: "button",
                  props: {
                    className:
                      "px-8 py-3 border-2 border-white rounded-lg font-semibold",
                  },
                  children: ["Learn More"],
                },
              ],
            },
          ],
        }],
      });

      const createFeatureGrid = () => ({
        type: "section",
        props: { className: "py-16 bg-gray-50" },
        children: [{
          type: "div",
          props: { className: "max-w-7xl mx-auto px-4" },
          children: [
            {
              type: "h2",
              props: { className: "text-3xl font-bold text-center mb-12" },
              children: ["Features"],
            },
            {
              type: "div",
              props: { className: "grid grid-cols-3 gap-8" },
              children: Array.from({ length: 9 }, (_, i) => ({
                type: "div",
                props: {
                  className:
                    "bg-white p-6 rounded-xl shadow-md hover:shadow-lg transition",
                },
                children: [
                  {
                    type: "div",
                    props: {
                      className:
                        "w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mb-4",
                    },
                    children: [{
                      type: "svg",
                      props: { className: "w-6 h-6 text-blue-600" },
                      children: [],
                    }],
                  },
                  {
                    type: "h3",
                    props: { className: "text-lg font-semibold mb-2" },
                    children: [`Feature ${i + 1}`],
                  },
                  {
                    type: "p",
                    props: { className: "text-gray-600" },
                    children: [
                      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt.",
                    ],
                  },
                ],
              })),
            },
          ],
        }],
      });

      const createPricingSection = () => ({
        type: "section",
        props: { className: "py-16" },
        children: [{
          type: "div",
          props: { className: "max-w-7xl mx-auto px-4" },
          children: [
            {
              type: "h2",
              props: { className: "text-3xl font-bold text-center mb-12" },
              children: ["Pricing"],
            },
            {
              type: "div",
              props: { className: "grid grid-cols-3 gap-8" },
              children: [
                { name: "Starter", price: 9, features: 5 },
                { name: "Pro", price: 29, features: 10 },
                { name: "Enterprise", price: 99, features: 20 },
              ].map((plan, i) => ({
                type: "div",
                props: {
                  className: `bg-white p-8 rounded-xl shadow-md ${
                    i === 1 ? "ring-2 ring-blue-500 scale-105" : ""
                  }`,
                },
                children: [
                  {
                    type: "h3",
                    props: { className: "text-xl font-semibold mb-4" },
                    children: [plan.name],
                  },
                  {
                    type: "p",
                    props: { className: "text-4xl font-bold mb-6" },
                    children: [`$${plan.price}`, {
                      type: "span",
                      props: { className: "text-lg text-gray-500" },
                      children: ["/mo"],
                    }],
                  },
                  {
                    type: "ul",
                    props: { className: "space-y-3 mb-8" },
                    children: Array.from({ length: plan.features }, (_, j) => ({
                      type: "li",
                      props: { className: "flex items-center" },
                      children: [
                        {
                          type: "svg",
                          props: { className: "w-5 h-5 text-green-500 mr-2" },
                          children: [],
                        },
                        {
                          type: "span",
                          props: {},
                          children: [`Feature ${j + 1}`],
                        },
                      ],
                    })),
                  },
                  {
                    type: "button",
                    props: {
                      className: `w-full py-3 rounded-lg font-semibold ${
                        i === 1 ? "bg-blue-600 text-white" : "bg-gray-100"
                      }`,
                    },
                    children: ["Choose Plan"],
                  },
                ],
              })),
            },
          ],
        }],
      });

      const createFooter = () => ({
        type: "footer",
        props: { className: "bg-gray-900 text-white py-12" },
        children: [{
          type: "div",
          props: { className: "max-w-7xl mx-auto px-4" },
          children: [
            {
              type: "div",
              props: { className: "grid grid-cols-4 gap-8 mb-8" },
              children: ["Product", "Company", "Resources", "Legal"].map((
                section,
                _i,
              ) => ({
                type: "div",
                props: {},
                children: [
                  {
                    type: "h4",
                    props: { className: "font-semibold mb-4" },
                    children: [section],
                  },
                  {
                    type: "ul",
                    props: { className: "space-y-2" },
                    children: Array.from({ length: 5 }, (_, j) => ({
                      type: "li",
                      props: {},
                      children: [{
                        type: "a",
                        props: {
                          href: "#",
                          className: "text-gray-400 hover:text-white",
                        },
                        children: [`${section} Link ${j + 1}`],
                      }],
                    })),
                  },
                ],
              })),
            },
            {
              type: "div",
              props: {
                className: "border-t border-gray-800 pt-8 flex justify-between",
              },
              children: [
                {
                  type: "p",
                  props: { className: "text-gray-400" },
                  children: ["© 2024 MyApp. All rights reserved."],
                },
                {
                  type: "div",
                  props: { className: "flex space-x-4" },
                  children: ["Twitter", "GitHub", "LinkedIn"].map((social) => ({
                    type: "a",
                    props: {
                      href: "#",
                      className: "text-gray-400 hover:text-white",
                    },
                    children: [social],
                  })),
                },
              ],
            },
          ],
        }],
      });

      return {
        type: "div",
        props: { className: "min-h-screen" },
        children: [
          createNavbar(),
          {
            type: "main",
            props: {},
            children: [
              createHeroSection(),
              createFeatureGrid(),
              createPricingSection(),
            ],
          },
          createFooter(),
        ],
      };
    })(),
  },
};

// Helper to create different hash functions for merkle-reference
async function createHashFunctions() {
  const functions: Record<string, (data: Uint8Array) => Uint8Array> = {};

  // Noble hashes (default for merkle-reference)
  functions["noble"] = (data: Uint8Array) => sha256(data);

  // hash-wasm SHA-256
  const sha256Hasher = await createSHA256();
  functions["hash-wasm"] = (data: Uint8Array) => {
    sha256Hasher.init();
    sha256Hasher.update(data);
    return sha256Hasher.digest("binary");
  };

  // hash-wasm BLAKE3
  const blake3Hasher = await createBLAKE3();
  functions["blake3-wasm"] = (data: Uint8Array) => {
    blake3Hasher.init();
    blake3Hasher.update(data);
    return blake3Hasher.digest("binary");
  };

  // Node crypto (only in Deno/Node)
  try {
    // @ts-ignore: dynamic import of node:crypto for Deno compatibility
    const nodeCrypto = await import("node:crypto");
    functions["node:crypto"] = (data: Uint8Array) => {
      return nodeCrypto.createHash("sha256").update(data).digest();
    };
  } catch {
    // Not available in browser
  }

  return functions;
}

// Hashing strategies to benchmark
async function createStrategies() {
  const hashFunctions = await createHashFunctions();
  const strategies: Record<string, (obj: any) => string> = {};

  // merkle-reference with default (noble) hash function
  strategies["merkle-reference[noble]"] = (obj: any) => {
    const ref = MerkleReference.refer(obj);
    return ref.toString();
  };

  // merkle-reference with different hash functions
  for (const [name, hashFn] of Object.entries(hashFunctions)) {
    if (name === "noble") continue; // Already handled above
    const treeBuilder = MerkleReference.Tree.createBuilder(hashFn);
    strategies[`merkle-reference[${name}]`] = (obj: any) => {
      const ref = treeBuilder.refer(obj);
      return ref.toString();
    };
  }

  // object-hash
  strategies["object-hash"] = (obj: any) => {
    return objectHash.default(obj);
  };

  // hash-it
  strategies["hash-it"] = (obj: any) => {
    return hashIt.default(obj).toString();
  };

  // All combinations of serialization + hash function
  const encoder = new TextEncoder();
  const toHex = (hash: Uint8Array) =>
    Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join("");

  // fast-json-stable-stringify with all hash functions
  for (const [hashName, hashFn] of Object.entries(hashFunctions)) {
    strategies[`fast-stable-stringify+${hashName}`] = (obj: any) => {
      const str = fastStableStringify.default(obj);
      const data = encoder.encode(str);
      return toHex(hashFn(data));
    };
  }

  // fast-json-stable-stringify + blake2b
  strategies["fast-stable-stringify+blake2b"] = (obj: any) => {
    const str = fastStableStringify.default(obj);
    const data = encoder.encode(str);
    return toHex(blake2b256(data));
  };

  // safe-stable-stringify with all hash functions
  for (const [hashName, hashFn] of Object.entries(hashFunctions)) {
    strategies[`safe-stable-stringify+${hashName}`] = (obj: any) => {
      const str = safeStableStringify.default(obj);
      const data = encoder.encode(str);
      return toHex(hashFn(data));
    };
  }

  // safe-stable-stringify + blake2b
  strategies["safe-stable-stringify+blake2b"] = (obj: any) => {
    const str = safeStableStringify.default(obj);
    const data = encoder.encode(str);
    return toHex(blake2b256(data));
  };

  // safe-stable-stringify + blake3
  strategies["safe-stable-stringify+blake3"] = (obj: any) => {
    const str = safeStableStringify.default(obj);
    const data = encoder.encode(str);
    return toHex(blake3(data));
  };

  // JSON.stringify (baseline - NOT stable for property order)
  strategies["JSON.stringify+noble (UNSTABLE)"] = (obj: any) => {
    const str = JSON.stringify(obj);
    const data = encoder.encode(str);
    return toHex(sha256(data));
  };

  // DAG-CBOR with all hash functions
  for (const [hashName, hashFn] of Object.entries(hashFunctions)) {
    strategies[`dag-cbor+${hashName}`] = (obj: any) => {
      const encoded = dagCbor.encode(obj);
      return toHex(hashFn(encoded));
    };
  }

  // DAG-CBOR + blake2b
  strategies["dag-cbor+blake2b"] = (obj: any) => {
    const encoded = dagCbor.encode(obj);
    return toHex(blake2b256(encoded));
  };

  // DAG-CBOR + blake3
  strategies["dag-cbor+blake3"] = (obj: any) => {
    const encoded = dagCbor.encode(obj);
    return toHex(blake3(encoded));
  };

  // DAG-CBOR with CID (Content Identifier - full IPLD approach)
  strategies["dag-cbor+CID"] = (obj: any) => {
    const encoded = dagCbor.encode(obj);
    const hash = sha256(encoded);
    // Create CID v1 with dag-cbor codec (0x71) and sha2-256 (0x12)
    const digest = multihash.create(0x12, hash);
    const cid = CID.createV1(0x71, digest);
    return cid.toString();
  };

  return strategies;
}

// Benchmark runner with fresh object cloning to avoid cache effects
function benchmark(
  _name: string,
  strategy: (obj: any) => string,
  templateData: any,
  iterations: number = 1000,
): number {
  // Pre-generate cloned objects to exclude clone time from measurement
  // Use JSON serialization as it's what we're testing against anyway
  const jsonStr = JSON.stringify(templateData);
  const objects = Array.from({ length: iterations }, () => JSON.parse(jsonStr));

  // Warmup with fresh objects
  for (let i = 0; i < Math.min(100, iterations / 10); i++) {
    strategy(objects[i % objects.length]);
  }

  // Actual benchmark - each iteration gets a fresh object (different reference)
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    strategy(objects[i]);
  }
  const end = performance.now();

  return end - start;
}

// Test stability (property order shouldn't matter)
function testStability(strategy: (obj: any) => string): boolean {
  const obj1 = { a: 1, b: 2, c: 3 };
  const obj2 = { c: 3, b: 2, a: 1 };
  const obj3 = { b: 2, a: 1, c: 3 };

  const hash1 = strategy(obj1);
  const hash2 = strategy(obj2);
  const hash3 = strategy(obj3);

  return hash1 === hash2 && hash2 === hash3;
}

// Main benchmark
async function main() {
  console.log("=== Object Hashing Benchmark ===\n");
  console.log(
    `Environment: ${typeof Deno !== "undefined" ? "Deno" : "Browser/Node"}\n`,
  );

  const strategies = await createStrategies();

  // Test stability
  console.log("## Stability Test (property order independence)\n");
  for (const [name, strategy] of Object.entries(strategies)) {
    const stable = testStability(strategy);
    console.log(`${name.padEnd(40)} ${stable ? "✓ STABLE" : "✗ UNSTABLE"}`);
  }
  console.log();

  // Benchmark each strategy on each data structure
  const results: Record<
    string,
    Record<string, { time: number; opsPerSec: number }>
  > = {};

  const testCases = [
    {
      category: "small",
      name: "simple",
      data: testData.small.simple,
      iterations: 10000,
    },
    {
      category: "small",
      name: "nested",
      data: testData.small.nested,
      iterations: 10000,
    },
    {
      category: "small",
      name: "array",
      data: testData.small.array,
      iterations: 10000,
    },
    {
      category: "small",
      name: "mixed",
      data: testData.small.mixed,
      iterations: 10000,
    },
    {
      category: "large",
      name: "wide",
      data: testData.large.wide,
      iterations: 1000,
    },
    {
      category: "large",
      name: "deep",
      data: testData.large.deep,
      iterations: 1000,
    },
    {
      category: "large",
      name: "largeArray",
      data: testData.large.largeArray,
      iterations: 100,
    },
    {
      category: "large",
      name: "sparse",
      data: testData.large.sparse,
      iterations: 1000,
    },
    {
      category: "large",
      name: "complex",
      data: testData.large.complex,
      iterations: 100,
    },
    // VDOM-like structures
    {
      category: "vdom",
      name: "simpleComp",
      data: testData.vdom.simpleComponent,
      iterations: 10000,
    },
    {
      category: "vdom",
      name: "form",
      data: testData.vdom.formComponent,
      iterations: 1000,
    },
    {
      category: "vdom",
      name: "dataTable",
      data: testData.vdom.dataTable,
      iterations: 100,
    },
    {
      category: "vdom",
      name: "dashboard",
      data: testData.vdom.dashboard,
      iterations: 100,
    },
    {
      category: "vdom",
      name: "fullPage",
      data: testData.vdom.fullPageApp,
      iterations: 50,
    },
  ];

  for (const testCase of testCases) {
    console.log(`\n## ${testCase.category}/${testCase.name}\n`);

    for (const [strategyName, strategy] of Object.entries(strategies)) {
      try {
        const time = await benchmark(
          strategyName,
          strategy,
          testCase.data,
          testCase.iterations,
        );
        const opsPerSec = (testCase.iterations / time) * 1000;

        if (!results[strategyName]) {
          results[strategyName] = {};
        }
        results[strategyName][`${testCase.category}/${testCase.name}`] = {
          time,
          opsPerSec,
        };

        console.log(
          `${strategyName.padEnd(40)} ${time.toFixed(2)}ms (${
            opsPerSec.toFixed(0)
          } ops/sec)`,
        );
      } catch (err) {
        console.log(`${strategyName.padEnd(40)} ERROR: ${err.message}`);
      }
    }
  }

  // Summary table
  console.log("\n\n=== SUMMARY (ops/sec - higher is better) ===\n");

  const strategyNames = Object.keys(strategies);
  const testNames = testCases.map((t) => `${t.category}/${t.name}`);

  // Header
  console.log(
    "Strategy".padEnd(40) +
      testNames
        .map((n) => {
          const short = n.split("/")[1].substring(0, 10);
          return short.padEnd(12);
        })
        .join(""),
  );
  console.log("-".repeat(40 + testNames.length * 12));

  // Rows
  for (const strategyName of strategyNames) {
    const row = strategyName.padEnd(40);
    const values = testNames.map((testName) => {
      const result = results[strategyName]?.[testName];
      if (!result) return "N/A".padEnd(12);
      const opsPerSec = result.opsPerSec;
      if (opsPerSec > 1000000) {
        return `${(opsPerSec / 1000000).toFixed(1)}M`.padEnd(12);
      } else if (opsPerSec > 1000) {
        return `${(opsPerSec / 1000).toFixed(1)}K`.padEnd(12);
      } else {
        return `${opsPerSec.toFixed(0)}`.padEnd(12);
      }
    });
    console.log(row + values.join(""));
  }

  console.log("\n=== DONE ===\n");
}

// Run if executed directly
if (import.meta.main) {
  main();
}

export { benchmark, createStrategies, testData, testStability };
