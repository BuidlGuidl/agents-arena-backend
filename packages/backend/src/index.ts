import { createLocalFundingGate, createWalletGate } from './chain/funding-gate.js';
import { createSolveWatch } from './chain/solve-poller.js';
import { createServer } from './server.js';

const port = Number(process.env.PORT ?? 4177);
const { app } = createServer({
  logger: true,
  walletGateFactory: (journal) => createWalletGate(journal),
  fundingGateFactory: (journal) => createLocalFundingGate(journal),
  solveWatchFactory: (journal) => createSolveWatch(journal),
});

await app.listen({ port, host: '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}
