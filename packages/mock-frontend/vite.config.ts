import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

const operatorToken = process.env.ARENA_OPERATOR_TOKEN ?? '';

// The backend requires an operator token on the control routes. The dev proxy
// adds it here, so the mock UI keeps working without the token reaching the browser.
const backendProxy: Record<string, ProxyOptions> = {
  '/runs': {
    target: 'http://localhost:4177',
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        if (operatorToken !== '') proxyReq.setHeader('authorization', `Bearer ${operatorToken}`);
      });
    },
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: backendProxy },
  preview: { proxy: backendProxy },
});
