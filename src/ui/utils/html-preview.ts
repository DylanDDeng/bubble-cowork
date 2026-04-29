export function isHtmlFilePath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/').split('?')[0]?.split('#')[0] || '';
  return /\.(?:html|htm)$/i.test(normalized);
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
  const preview = await window.electron.previewArtifactPath(cwd, filePath, {
    openInBrowser: false,
  });

  if (!preview.ok || !preview.url) {
    throw new Error(preview.message || 'Failed to resolve HTML preview URL.');
  }

  const currentState = await window.electron.browser.getState({ sessionId });
  if (currentState.tabs.length === 0) {
    await window.electron.browser.open({
      sessionId,
      initialUrl: preview.url,
    });
    return;
  }

  await window.electron.browser.newTab({
    sessionId,
    url: preview.url,
    activate: true,
  });
}
