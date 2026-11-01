import { describe, expect, it } from 'vitest';

import { APP_NAME, getWelcomeMessage } from './index';

describe('app info', () => {
  it('exposes the product name', () => {
    expect(APP_NAME).toBe('Temivo');
  });

  it('builds a platform-specific welcome message', () => {
    expect(getWelcomeMessage('desktop')).toBe(
      'Welcome to Temivo for desktop. Explore any topic through linked mind maps.',
    );
  });
});
