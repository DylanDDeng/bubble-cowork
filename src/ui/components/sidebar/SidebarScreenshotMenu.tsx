import { isMacPlatform, shortcutLabel } from '../../../shared/keyboard-shortcuts';
import { useAppPreferences } from '../../store/useAppPreferences';
import { ChevronRight, Screenshot } from '../icons';
import { openLastScreenshot, startScreenshotCapture } from '../screenshot/ScreenshotHost';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '../ui/dropdown-menu';

const itemClass = 'gap-2 px-2.5 text-[13px] text-[var(--text-secondary)]';

export function SidebarScreenshotMenu() {
  const shortcuts = useAppPreferences((state) => state.keyboardShortcuts);
  const isMac = isMacPlatform();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger openOnHover delay={120} closeDelay={200} className="gap-2 px-2 py-2 text-[var(--text-secondary)]">
        <Screenshot className="h-4 w-4 text-[var(--text-muted)]" />
        <span>Screenshot</span>
        <ChevronRight className="ml-auto h-3.5 w-3.5 text-[var(--text-muted)]" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent side="right" align="start" sideOffset={8} className="w-[210px]">
        {isMac ? (
          <>
            <DropdownMenuItem onSelect={() => void startScreenshotCapture('area')} className={itemClass}>
              <span>Capture area</span>
              <DropdownMenuShortcut>{shortcutLabel('screenshot', shortcuts)}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void startScreenshotCapture('window')} className={itemClass}>
              Capture window
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuItem onSelect={() => void startScreenshotCapture('app')} className={itemClass}>
          Capture Aegis window
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void openLastScreenshot()} className={itemClass}>
          Open last screenshot
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
