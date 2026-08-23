import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import * as electronIs from '@/utils/platform';

// Must run BEFORE any module captures `app.getPath('userData')` (e.g. `@/const/dir`
// reads it at top level). Once a path is read, `setPath` no longer protects modules
// that already cached the old value.
//
// Portable builds are identified by a marker beside the executable. All persistent
// Electron/Chromium state is rooted under ./data, so the whole directory can be moved,
// backed up or deleted without touching %APPDATA%.
const executableDir = path.dirname(process.execPath);
const portableMarker = path.join(executableDir, 'portable.flag');
const portableRequested = process.env.LOBE_DESKTOP_PORTABLE === '1' || existsSync(portableMarker);

if (!electronIs.dev() && portableRequested) {
  const portableDataRoot = path.resolve(
    process.env.LOBE_DESKTOP_PORTABLE_DATA_DIR || path.join(executableDir, 'data'),
  );
  const userDataPath = path.join(portableDataRoot, 'user-data');
  const sessionDataPath = path.join(portableDataRoot, 'session-data');
  const logsPath = path.join(portableDataRoot, 'logs');
  const crashDumpsPath = path.join(portableDataRoot, 'crash-dumps');

  for (const directory of [portableDataRoot, userDataPath, sessionDataPath, logsPath, crashDumpsPath]) {
    mkdirSync(directory, { recursive: true });
  }

  process.env.LOBE_DESKTOP_PORTABLE = '1';
  process.env.LOBE_DESKTOP_PORTABLE_ROOT = executableDir;
  process.env.LOBE_DESKTOP_PORTABLE_DATA_DIR = portableDataRoot;

  app.setPath('userData', userDataPath);
  app.setPath('sessionData', sessionDataPath);
  app.setPath('logs', logsPath);
  app.setPath('crashDumps', crashDumpsPath);
}

// Dev now uses the same `app://renderer/` origin as prod, so localStorage / cookies /
// IndexedDB would collide if both shared the packaged-app's userData dir. Pin dev to
// a sibling directory so prod sessions stay clean.
if (electronIs.dev()) {
  // App name stays constant so safeStorage / Chromium cookie encryption keys
  // (OS-keychain entries derived from the app name) keep decrypting a copied
  // login state across instances. Only userData varies per instance, which is
  // enough: Electron's single-instance lock is keyed by the userData dir, so
  // distinct dirs let multiple dev instances run concurrently. Override with an
  // absolute path via LOBE_DESKTOP_USER_DATA_DIR for multi-instance testing.
  app.setName('lobehub-desktop-dev');
  const userDataOverride = process.env.LOBE_DESKTOP_USER_DATA_DIR;
  app.setPath(
    'userData',
    userDataOverride || path.join(app.getPath('appData'), 'lobehub-desktop-dev'),
  );
}
