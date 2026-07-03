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
  const currentState = await window.electron.browser.getState({ sessionId });
  if (currentState.tabs.length === 0) {
    // open() only honors initialUrl when it creates the first tab. A freshly
    // mounted BrowserPanel races us with open(DEFAULT_HOME_URL); whoever loses
    // gets ignored, so verify the active tab and force-navigate on mismatch.
    const opened = await window.electron.browser.open({
      sessionId,
      initialUrl: url,
    });
    const activeTab = opened.tabs.find((tab) => tab.id === opened.activeTabId);
    if (activeTab && activeTab.url === url) {
      return;
    }
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
