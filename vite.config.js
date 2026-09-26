import { defineConfig } from 'vite';

// Safari 15+ (every current iPhone) supports top-level await, which main.js uses.
export default defineConfig({
  resolve: { dedupe: ['three'] },
  base: './',
  build: { target: 'es2022' },
  // Reached privately over Tailscale (tailnet only, never Funnel).
  preview: { allowedHosts: ['.ts.net'] },
  server: { allowedHosts: ['.ts.net'] },
});
