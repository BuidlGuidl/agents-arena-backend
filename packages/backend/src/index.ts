import { createFundingGate, runLocalDevFaucet } from './chain/funding-gate.js';
import { activeChainProfile } from './chain/profile.js';
import { createSolveWatch } from './chain/solve-poller.js';
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
const siwe = {
  operatorAddresses: parseCsvList(process.env.ARENA_OPERATOR_ADDRESSES),
  domains: parseCsvList(process.env.ARENA_SIWE_DOMAINS),
};

const { app } = ((): ReturnType<typeof createServer> => {
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

await app.listen({ port, host: '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}
