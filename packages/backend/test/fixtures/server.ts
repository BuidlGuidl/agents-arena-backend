import { afterEach } from 'vitest';
import type { EntrantDriver } from '../../src/adapters/types.js';
import type { ArenaServer } from '../../src/server.js';

export const noopDriver: EntrantDriver = {
  async prepare() {},
  async start() {},
  async steer() { return 'injected'; },
  async restart() {},
  async stop() {},
};

export function serverHarness(beforeClose?: (server: ArenaServer) => void): ArenaServer[] {
  const servers: ArenaServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => {
      beforeClose?.(server);
      await server.app.close();
    }));
  });
  return servers;
}
