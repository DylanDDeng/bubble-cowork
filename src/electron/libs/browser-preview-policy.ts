export const AEGIS_BLOCKED_BROWSER_OPEN_MESSAGE =
  'Aegis opens local HTML and localhost previews in its built-in browser panel. Do not launch the system browser; finish the file change and mention the path instead.';

const LOCAL_PREVIEW_TARGET_PATTERN =
  /(?:\.(?:html|htm)(?:[?#'"\s;&|)]|$)|file:\/\/|https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#'"\s;&|)]|$)|(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+)/i;
const SYSTEM_BROWSER_OPEN_COMMAND_PATTERN =
  /(?:^|[;&|()]\s*|\bthen\s+|\bdo\s+)(?:command\s+)?(?:open|xdg-open|gio\s+open|gnome-open|kde-open(?:\d+)?|wslview)\b/i;
const OSASCRIPT_BROWSER_OPEN_PATTERN = /\bosascript\b[\s\S]*\bopen\s+location\b/i;
const PYTHON_WEBBROWSER_OPEN_PATTERN =
  /\bpython(?:3(?:\.\d+)?)?\b[\s\S]*\b-m\s+webbrowser\b/i;

export function shouldBlockSystemBrowserPreviewOpen(command: string): boolean {
  if (!LOCAL_PREVIEW_TARGET_PATTERN.test(command)) {
    return false;
  }

  return (
    SYSTEM_BROWSER_OPEN_COMMAND_PATTERN.test(command) ||
    OSASCRIPT_BROWSER_OPEN_PATTERN.test(command) ||
    PYTHON_WEBBROWSER_OPEN_PATTERN.test(command)
  );
}
