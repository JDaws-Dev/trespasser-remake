import { defineConfig } from 'vite';

// Safari 15+ (every current iPhone) supports top-level await, which main.js uses.
export default defineConfig({
  resolve: { dedupe: ['three'] },
  // Pre-bundle every three addon we import, so Vite never serves a second copy of three mid-session.
  optimizeDeps: { include: ['three', 'three/examples/jsm/objects/Sky.js', 'three/examples/jsm/objects/Water.js', 'three/examples/jsm/csm/CSM.js',
    'three/examples/jsm/postprocessing/EffectComposer.js', 'three/examples/jsm/postprocessing/RenderPass.js', 'three/examples/jsm/postprocessing/GTAOPass.js',
    'three/examples/jsm/postprocessing/UnrealBloomPass.js', 'three/examples/jsm/postprocessing/SMAAPass.js', 'three/examples/jsm/postprocessing/OutputPass.js', 'three-mesh-bvh'] },
  base: './',
  build: { target: 'es2022' },
  // Reached privately over Tailscale (tailnet only, never Funnel).
  preview: { allowedHosts: ['.ts.net'] },
  server: { allowedHosts: ['.ts.net'] },
});
