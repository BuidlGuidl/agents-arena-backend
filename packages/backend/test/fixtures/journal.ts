import { afterEach } from 'vitest';
import { EventJournal } from '../../src/journal.js';

export function journalHarness(): () => EventJournal {
  const journals: EventJournal[] = [];
  afterEach(() => { for (const journal of journals.splice(0)) journal.close(); });
  return () => {
    const journal = new EventJournal(':memory:');
    journals.push(journal);
    return journal;
  };
}
