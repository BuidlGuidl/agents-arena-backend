import { describe, expect, it } from 'vitest';

import { CURATED_AGENTS, HARNESSES } from '../../src/agents/curated.js';
import { ROSTER_EFFORTS } from '../../src/contract.js';

describe('curated agents', () => {
  it('lists an agent for each harness', () => {
    for (const harness of HARNESSES) {
      expect(CURATED_AGENTS.some((agent) => agent.harness === harness.id)).toBe(true);
    }
  });

  it('pins unique agents with nonempty, valid efforts', () => {
    const pairs = CURATED_AGENTS.map((agent) => `${agent.harness}/${agent.model}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    for (const agent of CURATED_AGENTS) {
      expect(agent.efforts.length).toBeGreaterThan(0);
      expect(agent.efforts.every((effort) => ROSTER_EFFORTS.includes(effort))).toBe(true);
      if (agent.harness === 'opencode') expect(agent.model.startsWith('openrouter/')).toBe(true);
    }
  });
});
