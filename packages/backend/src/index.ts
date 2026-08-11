import closeWithGrace from 'close-with-grace';
import Docker from 'dockerode';

import { createFundingGate, runLocalDevFaucet } from './chain/funding-gate.js';
import { activeChainProfile } from './chain/profile.js';
import { createSolveWatch } from './chain/solve-poller.js';
import { resolveListenHost } from './config.js';
import { removeArenaResources } from './runtime/reconcile.js';
import { createServer } from './server.js';
import type { FundingGate } from './run-manager.js';
import { InvalidOperatorAddressError, MissingSiweDomainError, parseCsvList } from './siwe.js';

const port = Number(process.env.PORT ?? 4177);
const operatorToken = (process.env.ARENA_OPERATOR_TOKEN ?? '').trim();
const corsOrigins = parseCsvList(process.env.ARENA_CORS_ORIGINS);

// Fail closed: a deploy that forgets the token would leave the run controls open.
// Whitespace counts as forgotten — a blank token can never match a request.
if (operatorToken.length === 0) {
  console.error('ARENA_OPERATOR_TOKEN is required. Generate one with: openssl rand -hex 32');
  process.exit(1);
}

// The faucet tops entrants up the moment they exist, so the funding phase ends
// before an operator can reach the fund button. An unattended run needs it; a
// demo driven from the arena UI funds by hand.
const localFaucetEnabled = process.env.ARENA_LOCAL_FAUCET === 'true';

// Wallet login is optional: with no allowlist the arena stays token-only.
const operatorAddresses = parseCsvList(process.env.ARENA_OPERATOR_ADDRESSES);
const siwe = {
  operatorAddresses,
  domains: parseCsvList(process.env.ARENA_SIWE_DOMAINS),
};

// Local with auto-sign on is the one shape that seeds itself without an allowlist.
const autoSignCoversSeeding =
  activeChainProfile.name === 'local' && process.env.ARENA_AUTO_SIGN !== 'false';
if (!autoSignCoversSeeding && operatorAddresses.length === 0) {
  console.warn(
    'ARENA_OPERATOR_ADDRESSES is empty; no address can sign a seed, so runs will hold in awaiting_signature.',
  );
}

const { app, manager } = ((): ReturnType<typeof createServer> => {
  try {
    return createServer({
      operatorToken,
      siwe,
      corsOrigins,
      logger: true,
      fundingGateFactory: (journal) => {
        const fundingGate = createFundingGate(journal);
        if (activeChainProfile.name !== 'local' || !localFaucetEnabled) {
          return fundingGate;
        }
        const localFundingFlow: FundingGate = async (run, entrants, signal) => {
          await Promise.all([
            fundingGate(run, entrants, signal),
            runLocalDevFaucet(run, entrants, signal),
          ]);
        };
        return localFundingFlow;
      },
      solveWatchFactory: (journal) => createSolveWatch(journal),
    });
  } catch (error) {
    // A typo in the allowlist would otherwise lock the operator out mid-event.
    if (error instanceof InvalidOperatorAddressError) {
      console.error(`ARENA_OPERATOR_ADDRESSES is invalid: ${error.message}`);
      process.exit(1);
    }
    if (error instanceof MissingSiweDomainError) {
      console.error(
        'ARENA_SIWE_DOMAINS is required for wallet login. Set it to the hostname the wallet will show, such as the frontend host.',
      );
      process.exit(1);
    }
    throw error;
  }
})();

// The request timeout keeps a wedged daemon from hanging boot or eating the
// shutdown grace budget; this client only serves reconciliation.
const docker = new Docker({ timeout: 10_000 });
// A dev machine without a Docker daemon must still boot; leftovers get swept
// on the next start that does have one.
let bootResources = { containers: 0, networks: 0 };
try {
  bootResources = await removeArenaResources(docker, app.log);
} catch (error) {
  app.log.error(error);
}
let bootRunsFailed = 0;
try {
  bootRunsFailed = manager.failNonTerminalRuns('backend restarted while run was active');
} catch (error) {
  app.log.error(error);
}
app.log.info(
  `Boot reconciliation: ${bootResources.containers} containers, ${bootResources.networks} networks, ${bootRunsFailed} runs failed`,
);

await app.listen({ port, host: resolveListenHost() });

closeWithGrace({ delay: 25_000 }, async ({ signal, err }) => {
  if (err !== undefined) app.log.error(err);
  if (signal !== undefined) app.log.info(`Received ${signal}; shutting down`);

  // Stop accepting connections before touching state: a request landing after
  // the DB sweep below would pass the single-active-run guard and spawn
  // containers the Docker sweep never sees.
  app.server.close();

  // The DB write goes before the Docker sweep: the sweep is bounded but can
  // still spend seconds of the grace budget against a sick daemon.
  let runsFailed = 0;
  try {
    runsFailed = manager.failNonTerminalRuns('backend shut down during run');
  } catch (error) {
    app.log.error(error);
  }

  let removedContainers = 0;
  let removedNetworks = 0;
  try {
    const removed = await removeArenaResources(docker, app.log);
    removedContainers = removed.containers;
    removedNetworks = removed.networks;
  } catch (error) {
    app.log.error(error);
  }
  app.log.info(
    `Shutdown reconciliation: ${removedContainers} containers, ${removedNetworks} networks, ${runsFailed} runs failed`,
  );
  await app.close();
});
