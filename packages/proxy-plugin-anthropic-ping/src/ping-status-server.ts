import { EventEmitter } from "node:events";

export type PingStatusPayload = {
  name: string;
  tray: Array<{ icon: string; description?: string }>;
  remark?: string;
};

export type PingStatusEvent = {
  sessionId: string;
  payload: PingStatusPayload;
  updatedAt: number;
};

class PingStatusStore extends EventEmitter {
  private latest = new Map<string, PingStatusEvent>();

  set(sessionId: string, payload: PingStatusPayload): PingStatusEvent {
    const event: PingStatusEvent = { sessionId, payload, updatedAt: Date.now() };
    this.latest.set(sessionId, event);
    this.emit("update", event);
    return event;
  }

  get(sessionId: string): PingStatusEvent | undefined {
    return this.latest.get(sessionId);
  }

  subscribe(sessionId: string, cb: (event: PingStatusEvent) => void): () => void {
    const handler = (event: PingStatusEvent) => {
      if (event.sessionId === sessionId) cb(event);
    };
    this.on("update", handler);
    return () => {
      this.off("update", handler);
    };
  }
}

export const pingStatusStore = new PingStatusStore();
