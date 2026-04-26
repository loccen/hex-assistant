import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/tesseract.js/dist/worker.min.js",
          dest: "ocr-assets/tesseract",
          rename: { stripBase: true },
        },
        {
          src: [
            "node_modules/tesseract.js-core/tesseract-core*.js",
            "node_modules/tesseract.js-core/tesseract-core*.wasm",
          ],
          dest: "ocr-assets/tesseract-core",
          rename: { stripBase: true },
        },
        {
          src: "node_modules/@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz",
          dest: "ocr-assets/lang",
          rename: { stripBase: true },
        },
      ],
    }),
  ],
  clearScreen: false,
  server: {
    strictPort: false,
  },
});
