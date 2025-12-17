import { useState, useEffect, useCallback, useRef } from "react";

export interface ForwardComputedStats {
  failureRate: number;
  avgLatency: number;
  totalRequests: number;
  failedRequests: number;
  healthScore: number;
  dormancyFactor: number;
}

export interface ForwardStats {
  /** forward 唯一标识 */
  forwardId: string;
  /** 最近一次调用时间戳（ms） */
  lastCallTime: number;
  computed: ForwardComputedStats;
}

export interface StatsUpdateMessage {
  type: "stats-update";
  stats: ForwardStats[];
}

export function useForwardStats() {
  const [stats, setStats] = useState<Map<string, ForwardStats>>(new Map());
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/stats`);

    ws.onopen = () => {
      setConnected(true);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const message: unknown = JSON.parse(event.data);
        if (!message || typeof message !== "object") return;
        if (!("type" in message) || (message as { type?: unknown }).type !== "stats-update") return;
        if (!("stats" in message) || !Array.isArray((message as { stats?: unknown }).stats)) return;

        const typed = message as StatsUpdateMessage;
        if (typed.type === "stats-update") {
          const newMap = new Map<string, ForwardStats>();
          for (const stat of typed.stats) {
            if (!stat.forwardId) continue;
            newMap.set(stat.forwardId, stat);
          }
          setStats(newMap);
        }
      } catch (error) {
        console.error("Failed to parse stats message:", error);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      // 5秒后重连
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 5000);
    };

    ws.onerror = (error) => {
      console.error("Stats WebSocket error:", error);
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect]);

  const getStats = useCallback(
    (forwardId: string): ForwardStats | null => stats.get(forwardId) ?? null,
    [stats],
  );

  return { stats, connected, getStats };
}
