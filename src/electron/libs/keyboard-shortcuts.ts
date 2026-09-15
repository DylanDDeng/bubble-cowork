const captureSenders = new WeakSet<Electron.WebContents>();

/** Let the recorder receive chords normally consumed by native menu accelerators. */
export function setShortcutCaptureActive(sender: Electron.WebContents, active: boolean): void {
  if (!captureSenders.has(sender)) {
    captureSenders.add(sender);
    sender.on('did-start-loading', () => sender.setIgnoreMenuShortcuts(false));
    sender.on('render-process-gone', () => { if (!sender.isDestroyed()) sender.setIgnoreMenuShortcuts(false); });
  }
  sender.setIgnoreMenuShortcuts(active === true);
}
