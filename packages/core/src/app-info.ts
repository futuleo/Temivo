/** Product name shared by every Temivo client. */
export const APP_NAME = 'Temivo';

/** Returns the greeting shown on a client's start screen. */
export function getWelcomeMessage(platform: string): string {
  return `Welcome to ${APP_NAME} for ${platform}. Explore any topic through linked mind maps.`;
}
