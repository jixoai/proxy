import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ProxyInstance } from "@/types/proxy";

export type RequestStatus = "pending" | "streaming" | "completed" | "error";
export type WebSocketDirection = "send" | "receive" | null;

export interface RequestMetadata {
  method: string;
  url: string;
  headersCount: number;
  bodySize: number;
}

export interface ResponseMetadata {
  statusCode: number | null;
  statusMessage: string | null;
  headersCount: number;
  bodySize: number;
}

export interface RequestData {
  id: string;
  folderName: string;
  metadata: {
    timestamp: string;
    duration: string;
    instanceId: number;
    forwardRule?: {
      id: number;
      name: string;
      target_url: string;
    };
    status: RequestStatus;
    isWebSocket: boolean;
    websocketDirection: WebSocketDirection;
    errorMessage: string | null;
    targetUrl?: string;
    originUrl?: string;
    forwardedHeaders?: Record<string, string>;
    request: RequestMetadata;
    response: ResponseMetadata | null;
    /** hooks 是否有修改请求 */
    hasHookedRequest?: boolean;
    /** hooks 处理后的请求元数据 */
    hookedRequest?: RequestMetadata;
  };
  requestContent?: string;
  responseContent?: string;
  requestBody?: string;
  responseBody?: string;
  responseBodyFormatted?: string | null;
  responseBodyHighlighted?: string | null;
  /** hooks 处理后的请求头（markdown 格式） */
  hookedRequestContent?: string;
  /** hooks 处理后的请求体 */
  hookedRequestBody?: string;
}

interface ProxyViewerContextValue {
  requests: RequestData[];
  loading: boolean;
  currentPage: number;
  setCurrentPage: React.Dispatch<React.SetStateAction<number>>;

  livePush: boolean;
  setLivePush: (enabled: boolean) => void;
  wsConnected: boolean;

  filterMethod: string;
  setFilterMethod: (method: string) => void;
  filterStatus: string;
  setFilterStatus: (status: string) => void;
  filterUrl: string;
  setFilterUrl: (url: string) => void;
  filterRule: string;
  setFilterRule: (rule: string) => void;

  availableRules: Array<{ id: number; name: string }>;

  instances: ProxyInstance[];
  instancesLoading: boolean;
  reloadInstances: () => Promise<void>;
  activeInstanceId: number | null;
  setActiveInstanceId: (id: number | null) => void;
  activeRuleId: string | null;
  setActiveRuleId: (id: string | null) => void;
  controlFocusInstanceId: number | null;
  controlFocusForwardId: number | null;
  jumpToForwardRule: (instanceId: number, forwardId: number) => void;
  clearControlFocus: () => void;

  selectedId: string | null;
  selectedDetail: RequestData | null;
  detailLoading: boolean;
  selectRequest: (id: string | null) => Promise<void>;

  jsonDialogOpen: boolean;
  setJsonDialogOpen: (open: boolean) => void;
  dialogJSONSnapshot: string[];
  setDialogJSONSnapshot: (snapshot: string[]) => void;

  loadRequests: () => Promise<void>;
  handleClearAll: () => Promise<void>;
  deleteRequest: (id: string) => Promise<void>;
}

const ProxyViewerContext = createContext<ProxyViewerContextValue | null>(null);

export function useProxyViewer() {
  const context = useContext(ProxyViewerContext);
  if (!context) {
    throw new Error("useProxyViewer must be used within ProxyViewerProvider");
  }
  return context;
}

export function ProxyViewerProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [requests, setRequests] = useState<RequestData[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<RequestData | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [livePush, setLivePush] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);

  const [filterMethod, setFilterMethod] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterUrl, setFilterUrl] = useState<string>("");
  const [filterRule, setFilterRule] = useState<string>("");

  const [availableRules, setAvailableRules] = useState<Array<{ id: number; name: string }>>([]);

  const [instances, setInstances] = useState<ProxyInstance[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(true);
  const [activeInstanceId, setActiveInstanceId] = useState<number | null>(null);
  const [activeRuleId, setActiveRuleId] = useState<string | null>(null);
  const [controlFocusInstanceId, setControlFocusInstanceId] = useState<number | null>(null);
  const [controlFocusForwardId, setControlFocusForwardId] = useState<number | null>(null);

  const [jsonDialogOpen, setJsonDialogOpen] = useState(false);
  const [dialogJSONSnapshot, setDialogJSONSnapshot] = useState<string[]>([]);

  const loadRequests = useCallback(async () => {
    try {
      const response = await fetch("/api/requests");
      const data = await response.json();
      setRequests(data);
    } catch (error) {
      console.error("Failed to load requests:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleClearAll = useCallback(async () => {
    try {
      const response = await fetch("/api/clear", { method: "POST" });
      if (response.ok) {
        setRequests([]);
        setSelectedId(null);
        setSelectedDetail(null);
        setCurrentPage(1);
      }
    } catch (error) {
      console.error("Failed to clear requests:", error);
    }
  }, []);

  const deleteRequest = useCallback(
    async (id: string) => {
      try {
        const response = await fetch(`/api/requests/${id}`, {
          method: "DELETE",
        });
        if (response.ok) {
          setRequests((prev) => prev.filter((req) => req.id !== id));
          if (selectedId === id) {
            setSelectedId(null);
            setSelectedDetail(null);
          }
        }
      } catch (error) {
        console.error("Failed to delete request:", error);
      }
    },
    [selectedId],
  );

  const selectRequest = useCallback(async (id: string | null) => {
    setSelectedId(id);

    if (id === null) {
      setSelectedDetail(null);
      setDetailLoading(false);
      return;
    }

    setDetailLoading(true);
    setSelectedDetail(null);

    try {
      const response = await fetch(`/api/requests/${id}`);
      const data = await response.json();
      setSelectedDetail(data);
    } catch (error) {
      console.error("Failed to load request detail:", error);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadRules = useCallback(async () => {
    try {
      const response = await fetch("/api/forwards");
      const data = await response.json();
      setAvailableRules(data);
    } catch (error) {
      console.error("Failed to load rules:", error);
    }
  }, []);

  const reloadInstances = useCallback(async () => {
    setInstancesLoading(true);
    try {
      const response = await fetch("/api/instances");
      const data = await response.json();
      setInstances(data);
    } catch (error) {
      console.error("Failed to load instances:", error);
    } finally {
      setInstancesLoading(false);
    }
  }, []);

  const jumpToForwardRule = useCallback(
    (instanceId: number, forwardId: number) => {
      setControlFocusInstanceId(instanceId);
      setControlFocusForwardId(forwardId);
      navigate({ to: "/control" });
    },
    [navigate],
  );

  const clearControlFocus = useCallback(() => {
    setControlFocusInstanceId(null);
    setControlFocusForwardId(null);
  }, []);

  useEffect(() => {
    loadRequests();
    loadRules();
    reloadInstances();
  }, [loadRequests, loadRules, reloadInstances]);

  // WebSocket 连接
  useEffect(() => {
    if (!livePush) {
      setWsConnected(false);
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      console.log("WebSocket connected");
      setWsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "new-request" && message.data) {
          setRequests((prev) => [message.data, ...prev]);
          setCurrentPage(1);
        } else if (message.type === "update-request" && message.data) {
          const updatedId = String(message.id);
          setRequests((prev) => prev.map((req) => (req.id === updatedId ? message.data : req)));

          setSelectedDetail((prev) => {
            if (prev && prev.id === updatedId) {
              return { ...prev, ...message.data };
            }
            return prev;
          });
        } else if (message.type === "delete-request" && message.id) {
          const deletedId = String(message.id);
          setRequests((prev) => prev.filter((req) => req.id !== deletedId));
          if (selectedId === deletedId) {
            setSelectedId(null);
            setSelectedDetail(null);
          }
        } else if (message.type === "clear-all") {
          setRequests([]);
          setSelectedId(null);
          setSelectedDetail(null);
          setCurrentPage(1);
        } else if (message.type === "config-reloaded") {
          // 配置文件更新，刷新实例列表
          reloadInstances();
          loadRules();
        }
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      setWsConnected(false);
    };

    ws.onclose = () => {
      console.log("WebSocket disconnected");
      setWsConnected(false);
    };

    return () => {
      ws.close();
    };
  }, [livePush, selectedId, reloadInstances, loadRules]);

  const value: ProxyViewerContextValue = {
    requests,
    loading,
    currentPage,
    setCurrentPage,
    livePush,
    setLivePush,
    wsConnected,
    filterMethod,
    setFilterMethod,
    filterStatus,
    setFilterStatus,
    filterUrl,
    setFilterUrl,
    filterRule,
    setFilterRule,
    availableRules,
    instances,
    instancesLoading,
    reloadInstances,
    activeInstanceId,
    setActiveInstanceId,
    activeRuleId,
    setActiveRuleId,
    controlFocusInstanceId,
    controlFocusForwardId,
    jumpToForwardRule,
    clearControlFocus,
    selectedId,
    selectedDetail,
    detailLoading,
    selectRequest,
    jsonDialogOpen,
    setJsonDialogOpen,
    dialogJSONSnapshot,
    setDialogJSONSnapshot,
    loadRequests,
    handleClearAll,
    deleteRequest,
  };

  return <ProxyViewerContext.Provider value={value}>{children}</ProxyViewerContext.Provider>;
}
