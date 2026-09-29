import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface TurnChoice {
  choices: Record<string, boolean>;
  inspected: boolean;
}
interface Registry {
  turns: Record<string, TurnChoice>;
  setChoice: (turn: string, key: string, expanded: boolean) => void;
}
const RegistryContext = createContext<Registry | null>(null);
const Context = createContext<(TurnChoice & { setChoice: (key: string, expanded: boolean) => void }) | null>(null);
const emptyTurn: TurnChoice = { choices: {}, inspected: false };

/** Lives above timeline reconciliation; a streaming group may remount at final answer. */
export function WorkstreamDisclosureRegistry({ children }: { children: ReactNode }) {
  const [turns, setTurns] = useState<Record<string, TurnChoice>>({});
  const setChoice = useCallback((turn: string, key: string, expanded: boolean) => {
    setTurns(previous => {
      const current = previous[turn] ?? emptyTurn;
      return { ...previous, [turn]: {
        choices: { ...current.choices, [key]: expanded },
        inspected: current.inspected || (key !== 'turn' && expanded),
      } };
    });
  }, []);
  return <RegistryContext.Provider value={{ turns, setChoice }}>{children}</RegistryContext.Provider>;
}

/** Owned by the turn, outside lazily mounted activity details. */
export function WorkstreamDisclosureState({ children, scopeKey }: { children: ReactNode; scopeKey?: string | number | null }) {
  const registry = useContext(RegistryContext);
  const [local, setLocal] = useState<TurnChoice>(emptyTurn);
  const scope = scopeKey == null ? null : String(scopeKey);
  const current = registry && scope != null ? registry.turns[scope] ?? emptyTurn : local;
  const setChoice = (key: string, expanded: boolean) => {
    if (registry && scope != null) registry.setChoice(scope, key, expanded);
    else setLocal(previous => ({
      choices: { ...previous.choices, [key]: expanded },
      inspected: previous.inspected || (key !== 'turn' && expanded),
    }));
  };
  return <Context.Provider value={{ ...current, setChoice }}>{children}</Context.Provider>;
}

export function useWorkstreamDisclosureActions() {
  return useContext(Context)?.setChoice;
}

export function useWorkstreamWasInspected() {
  return useContext(Context)?.inspected ?? false;
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
