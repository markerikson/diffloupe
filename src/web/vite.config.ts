import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), Icons({ compiler: "jsx", jsx: "react" })],
  root: resolve(__dirname),
  build: {
    outDir: resolve(__dirname, "../../dist/web"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4517",
        changeOrigin: true,
      },
    },
  },
});
