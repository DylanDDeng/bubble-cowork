export function isHtmlFilePath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/').split('?')[0]?.split('#')[0] || '';
  return /\.(?:html|htm)$/i.test(normalized);
}

export async function resolveHtmlPreviewUrl({
  cwd,
  filePath,
}: {
  cwd: string;
  filePath: string;
}): Promise<string> {
  const preview = await window.electron.previewArtifactPath(cwd, filePath, {
    openInBrowser: false,
  });

  if (!preview.ok || !preview.url) {
    throw new Error(preview.message || 'Failed to resolve HTML preview URL.');
  }
  return preview.url;
}

export async function openUrlInBrowserSession({
  sessionId,
  url,
}: {
  sessionId: string;
  url: string;
}): Promise<void> {
  const current = await window.electron.browser.getState({ sessionId });
  if (!current.page) {
    // open() only uses initialUrl when it creates the page, and a panel that
    // just mounted may race us with its own open(): check what won.
    const opened = await window.electron.browser.open({ sessionId, initialUrl: url });
    if (opened.page?.url === url) return;
  }

  await window.electron.browser.navigate({
    sessionId,
    url,
  });
}

export async function openHtmlFileInBrowserTab({
  cwd,
  filePath,
  sessionId,
}: {
  cwd: string;
  filePath: string;
  sessionId: string;
}): Promise<void> {
  const url = await resolveHtmlPreviewUrl({ cwd, filePath });
  await openUrlInBrowserSession({ sessionId, url });
}
