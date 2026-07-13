import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Review Build Integration', () => {
  it('should have copied fixture data successfully during ci', () => {
    // In actual CI, the data/reviews directory is populated with fixtures before build.
    // We just check if it exists here for completeness if ran after cp.
    const hasData = fs.existsSync(path.join(process.cwd(), 'data', 'reviews'));
    expect(hasData).toBe(true);
  });
});
