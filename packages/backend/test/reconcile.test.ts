import type Docker from 'dockerode';
import { describe, expect, it, vi } from 'vitest';

import { removeArenaResources } from '../src/runtime/reconcile.js';

describe('removeArenaResources', () => {
  it('removes every arena-labeled container before its networks and continues after failures', async () => {
    const removeContainer = {
      first: vi.fn().mockResolvedValue(undefined),
      second: vi.fn().mockRejectedValue(new Error('container busy')),
    };
    const removeNetwork = {
      first: vi.fn().mockResolvedValue(undefined),
      second: vi.fn().mockRejectedValue(new Error('network busy')),
    };
    const listContainers = vi.fn().mockResolvedValue([{ Id: 'container-1' }, { Id: 'container-2' }]);
    const listNetworks = vi.fn().mockResolvedValue([{ Id: 'network-1' }, { Id: 'network-2' }]);
    const docker = {
      listContainers,
      getContainer: vi.fn((id: string) => ({
        remove: id === 'container-1' ? removeContainer.first : removeContainer.second,
      })),
      listNetworks,
      getNetwork: vi.fn((id: string) => ({
        remove: id === 'network-1' ? removeNetwork.first : removeNetwork.second,
      })),
    } as unknown as Docker;
    const logger = { error: vi.fn() };

    await expect(removeArenaResources(docker, logger)).resolves.toEqual({
      containers: 1,
      networks: 1,
    });
    expect(listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['arena.runId'] },
    });
    expect(listNetworks).toHaveBeenCalledWith({ filters: { label: ['arena.runId'] } });
    expect(removeContainer.first).toHaveBeenCalledWith({ force: true });
    expect(removeContainer.second).toHaveBeenCalledWith({ force: true });
    expect(removeNetwork.first).toHaveBeenCalledOnce();
    expect(removeNetwork.second).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
