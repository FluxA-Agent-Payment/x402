import { defineConfig } from "tsup";

const baseConfig = {
  entry: {
    index: "src/index.ts",
    "v1/index": "src/v1/index.ts",
    "exact/client/index": "src/exact/client/index.ts",
    "exact/server/index": "src/exact/server/index.ts",
    "exact/facilitator/index": "src/exact/facilitator/index.ts",
    "odp-deferred/client/index": "src/odp-deferred/client/index.ts",
    "odp-deferred/server/index": "src/odp-deferred/server/index.ts",
    "odp-deferred/facilitator/index": "src/odp-deferred/facilitator/index.ts",
    "exact/v1/client/index": "src/exact/v1/client/index.ts",
    "exact/v1/facilitator/index": "src/exact/v1/facilitator/index.ts",
  },
  dts: {
    resolve: true,
  },
  sourcemap: true,
  target: "es2020",
};

export default defineConfig([
  {
    ...baseConfig,
    format: "esm",
    outDir: "dist/esm",
    clean: true,
  },
  {
    ...baseConfig,
    format: "cjs",
    outDir: "dist/cjs",
    clean: false,
  },
]);
