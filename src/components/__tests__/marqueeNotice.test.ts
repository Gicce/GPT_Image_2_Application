import { describe, expect, it } from 'vitest';
import { calculateMarqueeCopies } from '../MarqueeNotice';

describe('calculateMarqueeCopies', () => {
  it('keeps enough repeated notices to cover a wide track plus the animation seam', () => {
    expect(calculateMarqueeCopies(1800, 300)).toBe(8);
    expect(calculateMarqueeCopies(2560, 500)).toBe(8);
  });

  it('always keeps a safe minimum while layout is being measured', () => {
    expect(calculateMarqueeCopies(0, 0)).toBe(2);
    expect(calculateMarqueeCopies(300, 800)).toBe(3);
  });
});
