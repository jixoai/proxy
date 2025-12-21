import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { PluginUiPayloadResolved } from "@/lib/plugin-ui";

export type PluginUiStreamData = {
  payload: PluginUiPayloadResolved;
  updatedAt: number;
};

type StreamEntry = {
  refCount: number;
  listeners: Set<(data: PluginUiStreamData) => void>;
  latest?: PluginUiStreamData;
  source: EventSource;
};

type PluginUiStreamContextValue = {
  subscribe: (streamUrl: string, cb: (data: PluginUiStreamData) => void) => () => void;
  getLatest: (streamUrl: string) => PluginUiStreamData | undefined;
};

const PluginUiStreamContext = createContext<PluginUiStreamContextValue | null>(null);

function parseStreamPayload(raw: string): PluginUiPayloadResolved | null {
  try {
    const parsed = JSON.parse(raw) as PluginUiPayloadResolved;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.name || typeof parsed.name !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function PluginUiStreamProvider({ children }: { children: ReactNode }) {
  const entriesRef = useRef(new Map<string, StreamEntry>());

  const getLatest = useCallback((streamUrl: string) => {
    return entriesRef.current.get(streamUrl)?.latest;
  }, []);

  const subscribe = useCallback(
    (streamUrl: string, cb: (data: PluginUiStreamData) => void) => {
      const existing = entriesRef.current.get(streamUrl);
      if (existing) {
        existing.refCount += 1;
        existing.listeners.add(cb);
        if (existing.latest) cb(existing.latest);
        return () => {
          existing.listeners.delete(cb);
          existing.refCount -= 1;
          if (existing.refCount <= 0) {
            existing.source.close();
            entriesRef.current.delete(streamUrl);
          }
        };
      }

      const source = new EventSource(streamUrl);
      const entry: StreamEntry = {
        refCount: 1,
        listeners: new Set([cb]),
        source,
      };
      entriesRef.current.set(streamUrl, entry);

      const handleMessage = (event: MessageEvent) => {
        const payload = parseStreamPayload(event.data);
        if (!payload) return;
        const data = { payload, updatedAt: Date.now() } as PluginUiStreamData;
        entry.latest = data;
        for (const listener of entry.listeners) {
          listener(data);
        }
      };

      const handleError = () => {
        // keep connection auto-retry by browser
      };

      source.addEventListener("message", handleMessage);
      source.addEventListener("error", handleError);

      return () => {
        entry.listeners.delete(cb);
        entry.refCount -= 1;
        if (entry.refCount <= 0) {
          source.close();
          entriesRef.current.delete(streamUrl);
        }
      };
    },
    [],
  );

  const value = useMemo(() => ({ subscribe, getLatest }), [subscribe, getLatest]);

  return (
    <PluginUiStreamContext.Provider value={value}>{children}</PluginUiStreamContext.Provider>
  );
}

export function usePluginUiStream() {
  const ctx = useContext(PluginUiStreamContext);
  if (!ctx) {
    throw new Error("usePluginUiStream must be used within PluginUiStreamProvider");
  }
  return ctx;
}
