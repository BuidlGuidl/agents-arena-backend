import { createFundingGate, runLocalDevFaucet } from './chain/funding-gate.js';
import { activeChainProfile } from './chain/profile.js';
import { createSolveWatch } from './chain/solve-poller.js';
import { createServer } from './server.js';
import type { FundingGate } from './run-manager.js';

const port = Number(process.env.PORT ?? 4177);
const { app } = createServer({
  logger: true,
  fundingGateFactory: (journal) => {
    const fundingGate = createFundingGate(journal);
    if (activeChainProfile.name !== 'local') {
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

await app.listen({ port, host: '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}
