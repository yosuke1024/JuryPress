import { describe, it, expect } from 'vitest';
import { EvidenceCollector } from '../../src/lib/evidence/collector';

describe('Url Security', () => {
  it('should block local IPs', () => {
    const collector = new EvidenceCollector();
    // testing private method via any
    const isPrivate = (collector as any).isPrivateIP('127.0.0.1');
    expect(isPrivate).toBe(true);

    const isPrivate2 = (collector as any).isPrivateIP('192.168.1.1');
    expect(isPrivate2).toBe(true);

    const isPrivate3 = (collector as any).isPrivateIP('8.8.8.8');
    expect(isPrivate3).toBe(false);
  });
});
