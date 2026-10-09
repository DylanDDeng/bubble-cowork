// Permission handling for the in-app browser's partition. Without handlers
// Electron grants camera, microphone, location, notifications and more to any
// page, including pages an agent opened; here each sensitive request asks the
// user in a native dialog, and the answer holds for that site until quit.

import { dialog, session, type BrowserWindow } from 'electron';
import { BROWSER_SESSION_PARTITION } from '../../shared/browser-types';
import {
  browserPermissionRule,
  PermissionGrants,
  permissionKinds,
  permissionOrigin,
  permissionQuestion,
  permissionSite,
} from './permission-policy';

const grants = new PermissionGrants();
/** One dialog per origin and request at a time; repeats wait for its answer. */
const pending = new Map<string, Promise<boolean>>();
let installed = false;

async function ask(
  getWindow: () => BrowserWindow | null,
  requestingUrl: string,
  kinds: string[],
  externalUrl?: string
): Promise<boolean> {
  const origin = permissionOrigin(requestingUrl);
  if (!origin) return false;
  const known = grants.answer(origin, kinds);
  if (known !== undefined) return known;
  const key = `${origin} ${kinds.join(',')}`;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const window = getWindow();
  if (!window || window.isDestroyed()) return false;
  const question = (async () => {
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'question',
        message: permissionQuestion(permissionSite(requestingUrl), kinds, externalUrl),
        detail: 'Requested by a page in the Aegis browser. Your answer applies to this site until Aegis quits.',
        buttons: ['Allow', 'Block'],
        defaultId: 1,
        cancelId: 1,
      });
      const allowed = response === 0;
      grants.record(origin, kinds, allowed);
      return allowed;
    } catch {
      return false;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, question);
  return question;
}

/** Install once; the window getter is read at request time. */
export function installBrowserSessionPolicy(getWindow: () => BrowserWindow | null): void {
  if (installed) return;
  installed = true;
  const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);

  browserSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const rule = browserPermissionRule(permission);
    if (rule !== 'ask') {
      callback(rule === 'allow');
      return;
    }
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    const externalUrl = 'externalURL' in details ? details.externalURL : undefined;
    const kinds = permissionKinds(permission, mediaTypes);
    void ask(getWindow, details.requestingUrl, kinds, externalUrl).then(callback, () => callback(false));
  });

  // Synchronous checks (navigator.permissions.query, clipboard reads) see
  // only what is always allowed or was already allowed for the site.
  browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const rule = browserPermissionRule(permission);
    if (rule !== 'ask') return rule === 'allow';
    const mediaType = 'mediaType' in details ? details.mediaType : undefined;
    const kinds = permissionKinds(permission, mediaType && mediaType !== 'unknown' ? [mediaType] : undefined);
    return grants.answer(permissionOrigin(requestingOrigin), kinds) === true;
  });
}

/** Test hook: forget the answers given so far. */
export function resetBrowserPermissionGrants(): void {
  grants.clear();
}
