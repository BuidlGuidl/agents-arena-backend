import { createLocalFundingGate, createWalletGate } from './chain/funding-gate.js';
import { createServer } from './server.js';

const port = Number(process.env.PORT ?? 4177);
const operatorToken = process.env.ARENA_OPERATOR_TOKEN ?? '';

// Fail closed: a deploy that forgets the token would leave the run controls open.
if (operatorToken.length === 0) {
  console.error('ARENA_OPERATOR_TOKEN is required. Generate one with: openssl rand -hex 32');
  process.exit(1);
}

const { app } = createServer({
  operatorToken,
  logger: true,
  walletGateFactory: (journal) => createWalletGate(journal),
  fundingGateFactory: (journal) => createLocalFundingGate(journal),
});

await app.listen({ port, host: '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}
