import { describe, expect, it } from 'vitest';
import { loadWindow, priority } from './streetview';

describe('speed-based load window', () => {
  it('reaches further ahead as speed rises, about 8 s of travel', () => {
    expect(loadWindow(0).ahead).toBe(60);
    expect(loadWindow(13.4).ahead).toBeCloseTo(167, 0); // 30 mph
    expect(loadWindow(31).ahead).toBeCloseTo(308, 0); // 70 mph
    expect(loadWindow(80).ahead).toBe(450); // capped
  });

  it('keeps a short tail behind and is lopsided toward travel', () => {
    const w = loadWindow(20);
    expect(w.behind).toBeLessThan(w.ahead / 3);
    expect(w.direction).toBe(1);
  });

  it('flips when reversing', () => {
    expect(loadWindow(-3).direction).toBe(-1);
    expect(loadWindow(-0.1).direction).toBe(1); // creeping doesn't flip it
  });

  it('loads what is just ahead before what is behind', () => {
    expect(priority(10)).toBeLessThan(priority(-10));
    expect(priority(5)).toBeLessThan(priority(40));
  });
});
