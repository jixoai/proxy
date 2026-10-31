import { createContext, useContext, useState, useSyncExternalStore, useCallback } from "react";
import { createModelRoutingDraftStore } from "@/lib/model-routing-drafts";

const DraftContext = createContext<ReturnType<typeof createModelRoutingDraftStore> | null>(null);

export function ModelRoutingDraftProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(createModelRoutingDraftStore);
  return <DraftContext.Provider value={store}>{children}</DraftContext.Provider>;
}

export function useModelRoutingSession(key: string) {
  const store = useContext(DraftContext);
  if (!store) throw new Error("Model routing editor requires a draft provider");
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(key, listener),
    [store, key],
  );
  const getSnapshot = useCallback(() => store.get(key), [store, key]);
  const session = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { session, store };
}
