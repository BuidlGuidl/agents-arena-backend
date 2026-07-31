import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = 'http://localhost:4177';
const operatorToken = process.env.ARENA_OPERATOR_TOKEN ?? '';

// The backend requires an operator credential on the control routes. The dev proxy
// adds the token here, so the mock UI works without the token reaching the browser.
// Once the operator signs in with a wallet the browser carries a session cookie,
// and the proxy stands aside so that path is exercised for real rather than masked.
const withOperatorToken: ProxyOptions = {
  target: BACKEND,
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq, request) => {
      const signedIn = (request.headers.cookie ?? '').split(';').some((cookie) => {
        const separator = cookie.indexOf('=');
        return separator >= 0
          && cookie.slice(0, separator).trim() === 'arena_operator'
          && cookie.slice(separator + 1).trim() !== '';
      });
      if (operatorToken !== '' && !signedIn) {
        proxyReq.setHeader('authorization', `Bearer ${operatorToken}`);
      }
    });
  },
};

const backendProxy: Record<string, ProxyOptions> = {
  '/runs': withOperatorToken,
  // Login carries its own credential (or mints one), so it proxies untouched.
  '/auth': { target: BACKEND },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: backendProxy },
  preview: { proxy: backendProxy },
});
