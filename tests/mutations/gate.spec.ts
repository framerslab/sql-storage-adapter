import { describe, expect, it } from 'vitest';
import { DrainGate, GateBlocked } from '../../src/features/sync/mutations/gate';
import { setStorageLogger } from '../../src/shared/logger';

describe('the drain gate', () => {
  it('turns new requests away under a blocked key and cancels the ones inside at once', () => {
    const gate = new DrainGate();
    const cancelled: string[] = [];
    gate.enter(['scope:1', 'group:1'], () => cancelled.push('inside'));
    gate.enter(['scope:2', 'group:2'], () => cancelled.push('elsewhere'));
    const block = gate.block('group:1');
    expect(cancelled).toEqual(['inside']);
    expect(() => gate.enter(['scope:1', 'group:1'], () => undefined)).toThrow(GateBlocked);
    expect(() => gate.enter(['scope:2', 'group:2'], () => undefined)).not.toThrow();
    block.release();
    expect(() => gate.enter(['scope:1', 'group:1'], () => undefined)).not.toThrow();
  });

  it('drains once the last request inside leaves, and says stuck when one stays past the deadline', async () => {
    const gate = new DrainGate();
    const leaving = gate.enter(['scope:1'], () => setTimeout(() => leaving.release(), 10));
    expect(await gate.block('scope:1').drain(1000)).toBe('drained');
    const gate2 = new DrainGate();
    gate2.enter(['scope:1'], () => undefined);
    const started = Date.now();
    expect(await gate2.block('scope:1').drain(50)).toBe('stuck');
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('holds a key blocked until every block on it is released', () => {
    const gate = new DrainGate();
    const one = gate.block('account:1');
    const two = gate.block('account:1');
    one.release();
    expect(gate.isBlocked('account:1')).toBe(true);
    two.release();
    two.release();
    expect(gate.isBlocked('account:1')).toBe(false);
  });

  it('keeps the block and cancels the other requests inside when one cancel throws, and writes one line saying so', async () => {
    const lines: string[] = [];
    setStorageLogger({ info: () => undefined, warn: (_fields, message) => lines.push(message), error: () => undefined });
    try {
      const gate = new DrainGate();
      const cancelled: string[] = [];
      gate.enter(['scope:1'], () => {
        throw new Error('the request had already ended');
      });
      const leaving = gate.enter(['scope:1'], () => {
        cancelled.push('second');
        leaving.release();
      });
      const block = gate.block('scope:1');
      expect(cancelled).toEqual(['second']);
      expect(lines).toHaveLength(1);
      expect(gate.isBlocked('scope:1')).toBe(true);
      expect(() => gate.enter(['scope:1'], () => undefined)).toThrow(GateBlocked);
      // the request whose cancel threw is still inside until it leaves
      expect(await block.drain(20)).toBe('stuck');
      block.release();
      expect(gate.isBlocked('scope:1')).toBe(false);
    } finally {
      setStorageLogger(null);
    }
  });
});
