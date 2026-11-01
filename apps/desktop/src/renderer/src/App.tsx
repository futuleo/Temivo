import { APP_NAME, getWelcomeMessage } from '@temivo/core';

export function App() {
  const { versions } = window.temivo;

  return (
    <main className="placeholder">
      <h1>{APP_NAME}</h1>
      <p>{getWelcomeMessage('desktop')}</p>
      <p className="versions">
        Electron {versions.electron} · Chromium {versions.chrome} · Node.js {versions.node}
      </p>
    </main>
  );
}
