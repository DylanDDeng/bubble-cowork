import type {
  PromptLibraryExportResult,
  PromptLibraryImportResult,
  PromptLibraryItem,
  UpsertPromptLibraryItemInput,
} from '../types';

function getPromptLibraryBridge() {
  const bridge = window.electron as ElectronAPI & {
    getPromptLibrary?: () => Promise<PromptLibraryItem[]>;
    savePromptLibraryItem?: (input: UpsertPromptLibraryItemInput) => Promise<PromptLibraryItem[]>;
    deletePromptLibraryItem?: (id: string) => Promise<PromptLibraryItem[]>;
    importPromptLibrary?: () => Promise<PromptLibraryImportResult>;
    exportPromptLibrary?: () => Promise<PromptLibraryExportResult>;
  };

  if (
    typeof bridge.getPromptLibrary !== 'function' ||
    typeof bridge.savePromptLibraryItem !== 'function' ||
    typeof bridge.deletePromptLibraryItem !== 'function' ||
    typeof bridge.importPromptLibrary !== 'function' ||
    typeof bridge.exportPromptLibrary !== 'function'
  ) {
    throw new Error('Prompt Library needs an Electron restart to load the new preload API.');
  }

  return bridge;
}

export function getPromptLibraryItems(): Promise<PromptLibraryItem[]> {
  return getPromptLibraryBridge().getPromptLibrary();
}

export function savePromptLibraryItem(input: UpsertPromptLibraryItemInput): Promise<PromptLibraryItem[]> {
  return getPromptLibraryBridge().savePromptLibraryItem(input);
}

export function deletePromptLibraryItem(id: string): Promise<PromptLibraryItem[]> {
  return getPromptLibraryBridge().deletePromptLibraryItem(id);
}

export function importPromptLibrary(): Promise<PromptLibraryImportResult> {
  return getPromptLibraryBridge().importPromptLibrary();
}

export function exportPromptLibrary(): Promise<PromptLibraryExportResult> {
  return getPromptLibraryBridge().exportPromptLibrary();
}
