import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface DisclosureState {
  choices: Record<string, boolean>;
  setChoice: (key: string, expanded: boolean) => void;
}
const Context = createContext<DisclosureState | null>(null);

/** Owned by the turn, outside lazily mounted activity details. */
export function WorkstreamDisclosureState({ children }: { children: ReactNode }) {
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const setChoice = useCallback((key: string, expanded: boolean) => {
    setChoices(previous => ({ ...previous, [key]: expanded }));
  }, []);
  return <Context.Provider value={{ choices, setChoice }}>{children}</Context.Provider>;
}

export function useWorkstreamDisclosure(key: string, defaultExpanded = false) {
  const context = useContext(Context);
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const expanded = (context?.choices ?? local)[key] ?? defaultExpanded;
  const setExpanded = (value: boolean) => {
    if (context) context.setChoice(key, value);
    else setLocal(previous => ({ ...previous, [key]: value }));
  };
  return [expanded, setExpanded] as const;
}
