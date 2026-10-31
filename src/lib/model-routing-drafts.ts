import type { ModelRouting } from "../types/proxy";
import { createModelRoutingDraft, type ModelRoutingDraft } from "./provider-routing-form";

export interface ModelRoutingEditSession {
  expected: ModelRouting | null;
  draft: ModelRoutingDraft;
  editing: string[];
  saving: boolean;
  reloading: boolean;
  needsReload: boolean;
  error: string;
  issues: { path: PropertyKey[]; message: string }[];
}

export function createModelRoutingSession(routing?: ModelRouting | null): ModelRoutingEditSession {
  return {
    expected: structuredClone(routing ?? null),
    draft: createModelRoutingDraft(routing),
    editing: [],
    saving: false,
    reloading: false,
    needsReload: false,
    error: "",
    issues: [],
  };
}

export function createModelRoutingDraftStore() {
  const sessions = new Map<string, ModelRoutingEditSession>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get(key: string) {
      return sessions.get(key);
    },
    set(key: string, session: ModelRoutingEditSession | undefined) {
      if (session) sessions.set(key, session);
      else sessions.delete(key);
      listeners.get(key)?.forEach((listener) => listener());
    },
    subscribe(key: string, listener: () => void) {
      const callbacks = listeners.get(key) ?? new Set();
      callbacks.add(listener);
      listeners.set(key, callbacks);
      return () => {
        callbacks.delete(listener);
        if (!callbacks.size) listeners.delete(key);
      };
    },
  };
}
