import type {
  ProjectUtilityPanelKind,
  ProjectUtilityPanelTarget,
} from '../types';

let fileTabCounter = 0;
let browserTabCounter = 0;

export function isRightUtilityFileTab(
  target: ProjectUtilityPanelTarget | null | undefined
): target is ProjectUtilityPanelTarget {
  return target === 'files' || Boolean(target?.startsWith('files:'));
}

export function isRightUtilityBrowserTab(
  target: ProjectUtilityPanelTarget | null | undefined
): target is ProjectUtilityPanelTarget {
  return target === 'browser' || Boolean(target?.startsWith('browser:'));
}

export function isRightUtilitySubagentTab(
  target: ProjectUtilityPanelTarget | null | undefined
): target is ProjectUtilityPanelTarget {
  return target === 'subagent' || Boolean(target?.startsWith('subagent:'));
}

export function getRightUtilityTabKind(
  target: ProjectUtilityPanelTarget
): ProjectUtilityPanelKind {
  if (isRightUtilityFileTab(target)) return 'files';
  if (isRightUtilityBrowserTab(target)) return 'browser';
  if (isRightUtilitySubagentTab(target)) return 'subagent';
  return target as ProjectUtilityPanelKind;
}

function createFileTabId(): ProjectUtilityPanelTarget {
  fileTabCounter += 1;
  return `files:${Date.now().toString(36)}-${fileTabCounter}`;
}

function createBrowserTabId(): ProjectUtilityPanelTarget {
  browserTabCounter += 1;
  return `browser:${Date.now().toString(36)}-${browserTabCounter}`;
}

export function addRightUtilityTab(
  tabs: ProjectUtilityPanelTarget[],
  target: ProjectUtilityPanelTarget
): ProjectUtilityPanelTarget[] {
  return tabs.includes(target) ? tabs : [...tabs, target];
}

export function resolveRightUtilityTabOpen(
  tabs: ProjectUtilityPanelTarget[],
  target: ProjectUtilityPanelKind,
  options?: { newTab?: boolean }
): { tabs: ProjectUtilityPanelTarget[]; activeTab: ProjectUtilityPanelTarget } {
  if (target === 'files') {
    const existing = tabs.find(isRightUtilityFileTab);
    const activeTab = options?.newTab || !existing ? createFileTabId() : existing;
    return {
      tabs: addRightUtilityTab(tabs, activeTab),
      activeTab,
    };
  }

  if (target === 'browser') {
    const activeTab = options?.newTab ? createBrowserTabId() : 'browser';
    return {
      tabs: addRightUtilityTab(tabs, activeTab),
      activeTab,
    };
  }

  return {
    tabs: addRightUtilityTab(tabs, target),
    activeTab: target,
  };
}

export function resolveRightUtilityTabOpenPreservingActive(
  tabs: ProjectUtilityPanelTarget[],
  target: ProjectUtilityPanelKind,
  activeTab: ProjectUtilityPanelTarget | null
): { tabs: ProjectUtilityPanelTarget[]; activeTab: ProjectUtilityPanelTarget } {
  if (target === 'files' && isRightUtilityFileTab(activeTab)) {
    return { tabs: addRightUtilityTab(tabs, activeTab), activeTab };
  }
  if (target === 'browser' && isRightUtilityBrowserTab(activeTab)) {
    return { tabs: addRightUtilityTab(tabs, activeTab), activeTab };
  }
  if (target !== 'files' && activeTab === target) {
    return { tabs: addRightUtilityTab(tabs, activeTab), activeTab };
  }
  return resolveRightUtilityTabOpen(tabs, target);
}
