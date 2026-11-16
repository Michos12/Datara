import { describe, expect, it } from 'vitest';
import { ERROR_CODES, problemSchema } from './problem.js';

describe('problemSchema', () => {
  it('accepts a validation problem with field errors', () => {
    const parsed = problemSchema.parse({
      type: 'https://docs.customer-insights.app/errors/validation',
      title: 'Validation failed',
      status: 422,
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'email', message: 'Must be a valid email' }],
    });
    expect(parsed.errors).toHaveLength(1);
  });

  it('maps every error code to an HTTP status', () => {
    for (const status of Object.values(ERROR_CODES)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});
