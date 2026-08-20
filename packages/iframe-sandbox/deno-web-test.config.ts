export default {
  // The guest runs in an iframe the test page creates, which loads its module
  // by URL and so cannot share the test's own bundle.
  bundle: {
    "src/guest.ts": "guest.js",
    "test/codec-entry.ts": "codec.js",
  },
  esbuildConfig: {
    supported: {
      using: false,
    },
    tsconfigRaw: {
      compilerOptions: {
        // `useDefineForClassFields` is critical when using Lit
        // with esbuild, even when not using decorators.
        useDefineForClassFields: false,
      },
    },
  },
};
