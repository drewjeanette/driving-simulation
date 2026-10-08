import { describe, expect, it } from 'vitest';
import { Transmission } from './transmission';

const stopped = { speed: 0, brake: 1 };

describe('Transmission', () => {
  it('starts in Park and follows P R N D order', () => {
    const t = new Transmission();
    expect(t.gear).toBe('P');
    expect(t.down(stopped).gear).toBe('R');
    expect(t.down(stopped).gear).toBe('N');
    expect(t.down(stopped).gear).toBe('D');
    expect(t.down(stopped).gear).toBe('D');
    expect(t.up(stopped).gear).toBe('N');
  });

  it('requires the brake to leave Park', () => {
    const t = new Transmission();
    const r = t.select('D', { speed: 0, brake: 0 });
    expect(r.ok).toBe(false);
    expect(t.gear).toBe('P');
    expect(t.select('D', { speed: 0, brake: 0.8 }).ok).toBe(true);
  });

  it('refuses Park or Reverse while rolling forward and leaves the lever alone', () => {
    const t = new Transmission();
    t.select('D', stopped);
    const r = t.select('P', { speed: 8, brake: 0 });
    expect(r.ok).toBe(false);
    expect(t.gear).toBe('D');
    expect(t.select('R', { speed: 3, brake: 0 }).ok).toBe(false);
    expect(t.select('N', { speed: 8, brake: 0 }).ok).toBe(true);
  });

  it('refuses Drive while rolling backward', () => {
    const t = new Transmission();
    t.select('R', stopped);
    expect(t.select('D', { speed: -2, brake: 0 }).ok).toBe(false);
    expect(t.select('D', { speed: 0, brake: 0 }).ok).toBe(true);
  });
});
