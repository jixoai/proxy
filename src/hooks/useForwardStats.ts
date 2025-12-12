import { useState, useEffect, useCallback, useRef } from "react";

export interface ForwardEndpointStats {
  instanceName: string;
  forwardName: string;
  endpointIndex: number;
  targetUrl: string;
  samples: Array<{
    timestamp: number;
    durationMs: number;
    success: boolean;
  }>;
  lastCallTime: number;
  computed: {
    failureRate: number;
    avgLatency: number;
    totalRequests: number;
    failedRequests: number;
    healthScore: number;
    dormancyFactor: number;
  };
}

export interface StatsUpdateMessage {
  type: "stats-update";
  stats: ForwardEndpointStats[];
}

export function useForwardStats() {
  const [stats, setStats] = useState<Map<string, ForwardEndpointStats>>(new Map());
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
        const message = JSON.parse(event.data) as StatsUpdateMessage;
        if (message.type === "stats-update") {
          const newMap = new Map<string, ForwardEndpointStats>();
          for (const stat of message.stats) {
            const key = `${stat.instanceName}/${stat.forwardName}/${stat.endpointIndex}`;
            newMap.set(key, stat);
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
    (
      instanceName: string,
      forwardName: string,
      endpointIndex: number,
    ): ForwardEndpointStats | null => {
      const key = `${instanceName}/${forwardName}/${endpointIndex}`;
      return stats.get(key) ?? null;
    },
    [stats],
  );

  const getForwardGroupStats = useCallback(
    (instanceName: string, forwardName: string): ForwardEndpointStats[] => {
      const result: ForwardEndpointStats[] = [];
      for (const [key, stat] of stats) {
        if (stat.instanceName === instanceName && stat.forwardName === forwardName) {
          result.push(stat);
        }
      }
      return result.sort((a, b) => a.endpointIndex - b.endpointIndex);
    },
    [stats],
  );

  return { stats, connected, getStats, getForwardGroupStats };
}
