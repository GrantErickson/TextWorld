import { defineConfig } from 'vite';

// `base: './'` keeps the built site portable: it works from a bare file://
// path, a subdirectory on GitHub Pages, or any static host without config.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  server: {
    open: true,
  },
});
