import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  define: {
    // Required for stellar-sdk in browser
    global: "globalThis",
  },
  resolve: {
    alias: {
      // Buffer polyfill
      buffer: fileURLToPath(new URL("./node_modules/buffer/index.js", import.meta.url)),
    },
    // Ensure symlinks are resolved to prevent duplicate module instances
    preserveSymlinks: false,
    // Force Vite to use a single instance of these packages
    dedupe: ["@stellar/stellar-sdk"],
  },
  optimizeDeps: {
    include: [
      "buffer",
      "@stellar/stellar-sdk",
      "@stellar/stellar-sdk/rpc",
    ],
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /smart-account-kit/, /smart-account-kit-bindings/],
      transformMixedEsModules: true,
    },
  },
});
