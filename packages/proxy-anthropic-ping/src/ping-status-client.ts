export type PingStatusPayload = {
  name: string;
  tray: Array<{ icon: string; description?: string }>;
  remark?: string;
};

export function pingStatusStreamUrl(baseUrl: string, sessionId: string): string {
  const normalizedBase = baseUrl.replace(/\/$/, "");
  return `${normalizedBase}/api/ping-status/stream?session=${encodeURIComponent(sessionId)}`;
}

export function pingStatusUiPayload(sessionId: string, stopped: boolean): PingStatusPayload {
  if (stopped) {
    return {
      name: "anthropic-ping",
      tray: [{ icon: "🖤", description: "保活停止" }],
      remark: `保活已停止 (session: ${sessionId.slice(0, 8)}...)`,
    };
  }
  return {
    name: "anthropic-ping",
    tray: [{ icon: "💗", description: "保活中" }],
    remark: `保活中 (session: ${sessionId.slice(0, 8)}...)`,
  };
}
