export default {
  include: {
    "../static/assets": "static",
  },
  esbuildConfig: {
    supported: {
      using: false,
    },
    external: [
      "source-map-support",
      "canvas",
      "inspector",
    ],
    tsconfigRaw: {
      compilerOptions: {
        // `useDefineForClassFields` is critical when using Lit
        // with esbuild, even when not using decorators.
        useDefineForClassFields: false,
        experimentalDecorators: true,
      },
    },
  },
};
