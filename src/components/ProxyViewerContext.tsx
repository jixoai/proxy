import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ProxyInstanceConfig, ProxyConfigFile } from "@/types/proxy";

export type RequestStatus = "pending" | "streaming" | "completed" | "error" | "aborted";
export type AbortReason = "client_disconnect" | "user_abort";
export type WebSocketDirection = "send" | "receive" | null;

export interface InstanceStatus {
  running: boolean;
  pid?: number;
  port: number;
  listeningPort?: number;
  uptime?: number;
}

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
    /** TTFB: 从请求发出到收到响应头的时间 (ms) */
    ttfbMs?: number;
    /** 从收到响应头到响应体接收完成的时间 (ms)，streaming 时为 undefined */
    bodyMs?: number;
    instanceName?: string;
    forwardName?: string;
    status: RequestStatus;
    abortReason?: AbortReason | null;
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
  setCurrentPage: (value: SetStateAction<number>, options?: { replace?: boolean }) => void;

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

  availableRules: Array<{ name: string; instanceName: string }>;

  instances: ProxyInstanceConfig[];
  instancesLoading: boolean;
  reloadInstances: () => Promise<void>;
  instanceStatuses: Record<string, InstanceStatus>;
  /** 实例配置同步状态：true=已同步, false=未同步, undefined=未知 */
  instanceConfigSyncStatus: Record<string, boolean | undefined>;
  activeInstanceName: string | null;
  setActiveInstanceName: (name: string | null) => void;
  activeRuleName: string | null;
  setActiveRuleName: (name: string | null) => void;
  controlFocusInstanceName: string | null;
  controlFocusForwardName: string | null;
  jumpToForwardRule: (instanceName: string, forwardName: string) => void;
  clearControlFocus: () => void;

  /** 配置版本号，每次配置重载时递增，子组件可监听此值触发刷新 */
  configVersion: number;
  /** 前端是否启用自动拉取配置（收到 config-changed 时自动刷新 UI） */
  frontendAutoPullConfig: boolean;
  setFrontendAutoPullConfig: (enabled: boolean) => Promise<void>;

  selectedId: string | null;
  selectedDetail: RequestData | null;
  detailLoading: boolean;
  selectRequest: (id: string | null, options?: { skipUrlSync?: boolean }) => Promise<void>;

  jsonDialogOpen: boolean;
  setJsonDialogOpen: (open: boolean) => void;
  dialogJSONSnapshot: string[];
  setDialogJSONSnapshot: (snapshot: string[]) => void;

  applySearchState: (search: SearchParams) => void;

  loadRequests: () => Promise<void>;
  handleClearAll: () => Promise<void>;
  deleteRequest: (id: string) => Promise<void>;
  abortRequest: (id: string) => Promise<boolean>;
}

const ProxyViewerContext = createContext<ProxyViewerContextValue | null>(null);

type SearchParams = {
  requestId?: string;
  dialog?: "json";
  page?: number;
  filterMethod?: string;
  filterStatus?: string;
  filterUrl?: string;
  filterRule?: string;
};

export function useProxyViewer() {
  const context = useContext(ProxyViewerContext);
  if (!context) {
    throw new Error("useProxyViewer must be used within ProxyViewerProvider");
  }
  return context;
}

export function ProxyViewerProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const applyingSearchRef = useRef(false);
  const [requests, setRequests] = useState<RequestData[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  const [selectedDetail, setSelectedDetail] = useState<RequestData | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [currentPage, setCurrentPageState] = useState(1);
  const currentPageRef = useRef(1);
  useEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);
  const [livePush, setLivePush] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const [filterMethod, setFilterMethodState] = useState<string>("");
  const [filterStatus, setFilterStatusState] = useState<string>("");
  const [filterUrl, setFilterUrlState] = useState<string>("");
  const [filterRule, setFilterRuleState] = useState<string>("");

  const [availableRules, setAvailableRules] = useState<Array<{ name: string; instanceName: string }>>([]);

  const [instances, setInstances] = useState<ProxyInstanceConfig[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(true);
  const [instanceStatuses, setInstanceStatuses] = useState<Record<string, InstanceStatus>>({});
  const [instanceConfigSyncStatus, setInstanceConfigSyncStatus] = useState<Record<string, boolean | undefined>>({});
  const [activeInstanceName, setActiveInstanceName] = useState<string | null>(null);
  const [activeRuleName, setActiveRuleNameState] = useState<string | null>(null);
  const [controlFocusInstanceName, setControlFocusInstanceName] = useState<string | null>(null);
  const [controlFocusForwardName, setControlFocusForwardName] = useState<string | null>(null);
  const [configVersion, setConfigVersion] = useState(0);
  const [frontendAutoPullConfig, setFrontendAutoPullConfigState] = useState(false);
  const frontendAutoPullConfigRef = useRef(false);
  useEffect(() => {
    frontendAutoPullConfigRef.current = frontendAutoPullConfig;
  }, [frontendAutoPullConfig]);

  const [jsonDialogOpen, setJsonDialogOpenState] = useState(false);
  const [dialogJSONSnapshot, setDialogJSONSnapshot] = useState<string[]>([]);

  const cleanSearch = useCallback((search: SearchParams) => {
    const next = { ...search };
    Object.keys(next).forEach((key) => {
      const k = key as keyof SearchParams;
      if (next[k] === undefined || next[k] === null || next[k] === "") {
        delete next[k];
      }
    });
    return next;
  }, []);

  const updateSearch = useCallback(
    (updater: (prev: SearchParams) => SearchParams, options?: { replace?: boolean }) => {
      navigate({
        to: "/",
        search: (prev) => cleanSearch(updater(prev as SearchParams)),
        replace: options?.replace,
      });
    },
    [cleanSearch, navigate],
  );

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

  const abortRequest = useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await fetch(`/api/requests/${id}/abort`, {
        method: "POST",
      });
      const result = await response.json();
      return result.success === true;
    } catch (error) {
      console.error("Failed to abort request:", error);
      return false;
    }
  }, []);

  const selectRequest = useCallback(
    async (id: string | null, options?: { skipUrlSync?: boolean }) => {
      setSelectedId(id);

      if (!options?.skipUrlSync && !applyingSearchRef.current) {
        updateSearch((prev) => ({ ...prev, requestId: id ?? undefined }));
      }

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
    },
    [updateSearch],
  );

  const fetchConfig = useCallback(async (): Promise<ProxyConfigFile> => {
    const response = await fetch("/api/config");
    return response.json();
  }, []);

  const loadRules = useCallback(async () => {
    try {
      const config = await fetchConfig();
      const rules: Array<{ name: string; instanceName: string }> = [];
      for (const instance of config.instances) {
        for (const forward of instance.forwards) {
          if (forward.enabled) {
            rules.push({ name: forward.name, instanceName: instance.name });
          }
        }
      }
      setAvailableRules(rules);
    } catch (error) {
      console.error("Failed to load rules:", error);
    }
  }, [fetchConfig]);

  const reloadInstances = useCallback(async () => {
    setInstancesLoading(true);
    try {
      const config = await fetchConfig();
      setInstances(config.instances);
      setFrontendAutoPullConfigState(Boolean(config.settings?.frontendAutoPullConfig));
    } catch (error) {
      console.error("Failed to load instances:", error);
    } finally {
      setInstancesLoading(false);
    }
  }, [fetchConfig]);

  const jumpToForwardRule = useCallback(
    (instanceName: string, forwardName: string) => {
      setControlFocusInstanceName(instanceName);
      setControlFocusForwardName(forwardName);
      navigate({ to: "/control" });
    },
    [navigate],
  );

  const clearControlFocus = useCallback(() => {
    setControlFocusInstanceName(null);
    setControlFocusForwardName(null);
  }, []);

  const setCurrentPage = useCallback(
    (value: SetStateAction<number>, options?: { replace?: boolean }) => {
      setCurrentPageState(value);
      const resolved = typeof value === "function" ? value(currentPageRef.current) : value;
      // Only update URL when on the home page to avoid unexpected navigation from other routes
      if (!applyingSearchRef.current && window.location.pathname === "/") {
        updateSearch(
          (prev) => ({
            ...prev,
            page: resolved,
          }),
          { replace: options?.replace },
        );
      }
    },
    [updateSearch],
  );

  const setJsonDialogOpen = useCallback(
    (open: boolean) => {
      setJsonDialogOpenState(open);
      if (!applyingSearchRef.current) {
        updateSearch((prev) => ({ ...prev, dialog: open ? "json" : undefined }));
      }
    },
    [updateSearch],
  );

  const setFilterMethod = useCallback(
    (method: string) => {
      setFilterMethodState(method);
      setCurrentPageState(1);
      if (!applyingSearchRef.current) {
        updateSearch((prev) => ({
          ...prev,
          filterMethod: method || undefined,
          page: 1,
        }));
      }
    },
    [updateSearch],
  );

  const setFilterStatus = useCallback(
    (status: string) => {
      setFilterStatusState(status);
      setCurrentPageState(1);
      if (!applyingSearchRef.current) {
        updateSearch((prev) => ({
          ...prev,
          filterStatus: status || undefined,
          page: 1,
        }));
      }
    },
    [updateSearch],
  );

  const setFilterUrl = useCallback(
    (url: string) => {
      setFilterUrlState(url);
      setCurrentPageState(1);
      if (!applyingSearchRef.current) {
        updateSearch((prev) => ({
          ...prev,
          filterUrl: url || undefined,
          page: 1,
        }));
      }
    },
    [updateSearch],
  );

  const setFilterRule = useCallback(
    (rule: string) => {
      setFilterRuleState(rule);
      setCurrentPageState(1);
      if (!applyingSearchRef.current) {
        updateSearch((prev) => ({
          ...prev,
          filterRule: rule || undefined,
          page: 1,
        }));
      }
    },
    [updateSearch],
  );

  const setActiveRuleName = useCallback(
    (name: string | null) => {
      setActiveRuleNameState(name);
      setFilterRule(name ?? "");
    },
    [setFilterRule],
  );

  const applySearchState = useCallback(
    (search: SearchParams) => {
      applyingSearchRef.current = true;
      const nextPage = search.page ?? 1;
      setCurrentPageState(nextPage);
      setFilterMethodState(search.filterMethod ?? "");
      setFilterStatusState(search.filterStatus ?? "");
      setFilterUrlState(search.filterUrl ?? "");
      setFilterRuleState(search.filterRule ?? "");
      setActiveRuleNameState(search.filterRule ?? null);
      setJsonDialogOpenState(search.dialog === "json");

      if (search.requestId) {
        void selectRequest(search.requestId, { skipUrlSync: true });
      } else {
        setSelectedId(null);
        setSelectedDetail(null);
        setDetailLoading(false);
      }

      applyingSearchRef.current = false;
    },
    [selectRequest],
  );

  const setFrontendAutoPullConfig = useCallback(
    async (enabled: boolean) => {
      setFrontendAutoPullConfigState(enabled);
      try {
        const config = await fetchConfig();
        const currentEnabled = config.settings?.frontendAutoPullConfig;
        if (typeof currentEnabled === "boolean" && currentEnabled === enabled) {
          if (enabled) {
            reloadInstances();
            loadRules();
            setConfigVersion((v) => v + 1);
          }
          return;
        }

        const nextConfig: ProxyConfigFile = {
          ...config,
          settings: {
            ...config.settings,
            frontendAutoPullConfig: enabled,
          },
        };

        const response = await fetch("/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(nextConfig),
        });
        if (!response.ok) {
          setFrontendAutoPullConfigState(!enabled);
          console.error("Failed to update frontendAutoPullConfig:", await response.text());
          return;
        }

        // 开启后立即同步一次数据
        if (enabled) {
          reloadInstances();
          loadRules();
          setConfigVersion((v) => v + 1);
        }
      } catch (error) {
        console.error("Failed to update frontendAutoPullConfig:", error);
        setFrontendAutoPullConfigState(!enabled);
      }
    },
    [fetchConfig, reloadInstances, loadRules],
  );

  useEffect(() => {
    loadRequests();
    loadRules();
    reloadInstances();
  }, [loadRequests, loadRules, reloadInstances]);

  // WebSocket 连接
  useEffect(() => {
    if (!livePush) {
      setWsConnected(false);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        } finally {
          wsRef.current = null;
        }
      }
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    // React 18 StrictMode (dev) 会触发 mount → unmount → mount，延迟连接可避免第一次的“瞬连瞬断”。
    const connectTimer = window.setTimeout(() => {
      if (disposed) return;

      socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        if (wsRef.current !== socket) return;
        console.log("WebSocket connected");
        setWsConnected(true);
      };

      socket.onmessage = (event) => {
        if (wsRef.current !== socket) return;

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
            if (selectedIdRef.current === deletedId) {
              setSelectedId(null);
              setSelectedDetail(null);
            }
          } else if (message.type === "clear-all") {
            setRequests([]);
            setSelectedId(null);
            setSelectedDetail(null);
            setCurrentPage(1);
          } else if (message.type === "config-changed") {
            // 全局开关语义：只有当前页面开着 autoPull，才会响应 config-changed 并拉取最新配置。
            // 如果当前页面已关闭 autoPull，则忽略任何配置变更（包含别人把 autoPull 再打开）。
            if (!frontendAutoPullConfigRef.current) return;
            reloadInstances();
            loadRules();
            setConfigVersion((v) => v + 1);
          } else if (message.type === "all-instance-states" && message.statuses) {
            // 收到所有实例状态（连接时或批量更新）
            setInstanceStatuses(message.statuses);
          } else if (message.type === "instance-state-changed" && message.instanceName) {
            // 单个实例状态变更
            setInstanceStatuses((prev) => ({
              ...prev,
              [message.instanceName]: message.status,
            }));
          } else if (message.type === "instance-config-change" && message.instanceName) {
            // 实例配置同步状态变更
            setInstanceConfigSyncStatus((prev) => ({
              ...prev,
              [message.instanceName]: message.synced,
            }));
          }
        } catch (error) {
          console.error("Failed to parse WebSocket message:", error);
        }
      };

      socket.onerror = (error) => {
        if (wsRef.current !== socket) return;
        console.error("WebSocket error:", error);
        setWsConnected(false);
      };

      socket.onclose = () => {
        if (wsRef.current !== socket) return;
        console.log("WebSocket disconnected");
        setWsConnected(false);
      };
    }, 50);

    return () => {
      disposed = true;
      window.clearTimeout(connectTimer);

      if (!socket) return;

      if (wsRef.current === socket) {
        wsRef.current = null;
        setWsConnected(false);
      }

      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        try {
          socket.close();
        } catch (error) {
          console.warn("Failed to close WebSocket:", error);
        }
      }
    };
  }, [livePush, reloadInstances, loadRules, fetchConfig]);

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
    instanceStatuses,
    instanceConfigSyncStatus,
    activeInstanceName,
    setActiveInstanceName,
    activeRuleName,
    setActiveRuleName,
    controlFocusInstanceName,
    controlFocusForwardName,
    jumpToForwardRule,
    clearControlFocus,
    configVersion,
    frontendAutoPullConfig,
    setFrontendAutoPullConfig,
    selectedId,
    selectedDetail,
    detailLoading,
    selectRequest,
    jsonDialogOpen,
    setJsonDialogOpen,
    dialogJSONSnapshot,
    setDialogJSONSnapshot,
    applySearchState,
    loadRequests,
    handleClearAll,
    deleteRequest,
    abortRequest,
  };

  return <ProxyViewerContext.Provider value={value}>{children}</ProxyViewerContext.Provider>;
}
