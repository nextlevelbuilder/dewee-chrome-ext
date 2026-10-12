import type { Agent } from '../../../src/api/schemas';
import { sortAgents } from '../../../src/sidepanel/use-directory';

const agent = (overrides: Partial<Agent> & { key: string }): Agent => ({
  id: undefined,
  name: '',
  status: 'active',
  model: undefined,
  provider: undefined,
  is_super: false,
  ...overrides,
});

describe('sortAgents', () => {
  it('pins the Super Agent first, by flag or by its well-known key', () => {
    const sorted = sortAgents([
      agent({ key: 'zeta', name: 'Zeta' }),
      agent({ key: 'flagged', name: 'Alpha', is_super: true }),
      agent({ key: 'super-agent', name: 'Beta' }),
    ]);
    expect(sorted.map((a) => a.key)).toEqual(['flagged', 'super-agent', 'zeta']);
  });

  it('honours a super key supplied by the Gateway', () => {
    const sorted = sortAgents([agent({ key: 'aaa', name: 'Aaa' }), agent({ key: 'hub', name: 'Hub' })], 'hub');
    expect(sorted.map((a) => a.key)).toEqual(['hub', 'aaa']);
  });

  it('removes agents that are not active', () => {
    const sorted = sortAgents([
      agent({ key: 'on', name: 'On' }),
      agent({ key: 'off', name: 'Off', status: 'inactive' }),
      agent({ key: 'paused', name: 'Paused', status: 'suspended' }),
    ]);
    expect(sorted.map((a) => a.key)).toEqual(['on']);
  });

  it('sorts the rest alphabetically, falling back to the key when the name is empty', () => {
    const sorted = sortAgents([
      agent({ key: 'zeta', name: 'zeta-name' }),
      agent({ key: 'beta', name: 'Beta' }),
      agent({ key: 'alpha-key', name: '' }),
    ]);
    expect(sorted.map((a) => a.key)).toEqual(['alpha-key', 'beta', 'zeta']);
  });

  it('does not reorder the input array', () => {
    const input = [agent({ key: 'b', name: 'B' }), agent({ key: 'a', name: 'A' })];
    sortAgents(input);
    expect(input.map((a) => a.key)).toEqual(['b', 'a']);
  });
});
