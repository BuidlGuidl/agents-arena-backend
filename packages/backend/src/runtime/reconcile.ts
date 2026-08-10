import type Docker from 'dockerode';

export interface ArenaResourceCounts {
  containers: number;
  networks: number;
}

interface ReconcileLogger {
  error(message: string): void;
}

export async function removeArenaResources(
  docker: Docker,
  logger: ReconcileLogger = console,
): Promise<ArenaResourceCounts> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: ['arena.runId'] },
  });
  let removedContainers = 0;
  for (const { Id } of containers) {
    try {
      await docker.getContainer(Id).remove({ force: true });
      removedContainers += 1;
    } catch (error) {
      logger.error(`Failed to remove arena container ${Id}: ${errorMessage(error)}`);
    }
  }

  // Guarded separately so a failure here still reports the containers removed above.
  let removedNetworks = 0;
  try {
    const networks = await docker.listNetworks({ filters: { label: ['arena.runId'] } });
    for (const { Id } of networks) {
      if (Id === undefined) continue;
      try {
        await docker.getNetwork(Id).remove();
        removedNetworks += 1;
      } catch (error) {
        logger.error(`Failed to remove arena network ${Id}: ${errorMessage(error)}`);
      }
    }
  } catch (error) {
    logger.error(`Failed to list arena networks: ${errorMessage(error)}`);
  }

  return { containers: removedContainers, networks: removedNetworks };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
