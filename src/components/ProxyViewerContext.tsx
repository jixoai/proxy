import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { sanitizePluginUiPayload, type PluginUiRecord } from "@/lib/plugin-ui";
import { usePluginUiStream } from "@/contexts/PluginUiStreamContext";
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

/** 插件标记信息 */
export interface PluginInfo {
  /** 请求的发起插件（如心跳请求由 anthropic-ping 发起） */
  pluginOrigin?: string;
  /** 处理过该请求的插件列表 */
  pluginsProcessed?: string[];
  /** 请求类型：normal, ping, session-cancelled 等 */
  requestType?: string;
  /** 会话 ID */
  sessionId?: string;
  /** 心跳计数 */
  pingCount?: number;
}

/** 单层 hook 执行结果 */
export interface HookLayer {
  /** 插件名称 */
  pluginName: string;
  /** 是否修改了内容 */
  modified: boolean;
  /** 以下字段仅在 modified=true 时存在 */
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  bodyDataUrl?: string | null;
  bodySize?: number;
  /** Response 特有字段 */
  statusCode?: number;
  statusMessage?: string;
  contentType?: string | null;
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
    /** forward 的唯一 id，用于精确匹配同名 forward */
    forwardId?: string;
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
    /** hooks 是否有修改响应 */
    hasHookedResponse?: boolean;
    /** hooks 处理后的响应元数据 */
    hookedResponse?: ResponseMetadata;
    /** 每层 request hook 的执行结果 */
    requestHookLayers?: HookLayer[];
    /** 每层 response hook 的执行结果 */
    responseHookLayers?: HookLayer[];
    /** 插件标记信息 */
    pluginInfo?: PluginInfo;
    /** 插件 UI 信息（tray/remark/stream） */
    pluginUi?: {
      records: PluginUiRecord[];
      order: string[];
      version: number;
    };
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
  /** hooks 处理后的响应头（markdown 格式） */
  hookedResponseContent?: string;
  /** hooks 处理后的响应体 */
  hookedResponseBody?: string;
}

interface ProxyViewerContextValue {
  /** 当前显示的请求数据（已按分页加载） */
  requests: RequestData[];
  /** 请求总数 */
  totalCount: number;
  /** 初次加载中（显示全屏加载状态） */
  loading: boolean;
  /** 页面切换加载中（显示顶部进度条，保留现有数据） */
  pageLoading: boolean;
  /** 多页分页参数，格式：anchor,count（如 "-1,2" 或 "4,2"） */
  pagesParam: string | undefined;
  /** 更新多页分页参数 */
  setPagesParam: (value: string) => void;
  /** 每页数据条数 */
  pageSize: number;
  /** 更新每页数据条数 */
  setPageSize: (value: number) => void;
  /** 加载指定页的数据 */
  loadPages: (pages: number[]) => Promise<void>;

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
  detailNotFound: boolean;
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
  /** 多页分页参数，格式：anchor,count */
  pages?: string;
  /** 每页数据条数 */
  pageSize?: string;
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
  const stream = usePluginUiStream();
  const pluginUiCacheRef = useRef(new Map<string, { payload: PluginUiRecord["payload"]; updatedAt: number }>());
  const pluginUiSubsRef = useRef(new Map<string, { unsub: () => void }>());
  const pluginUiSubscribedRef = useRef(new Set<string>());
  const applyPluginUiDynamic = useCallback((records: PluginUiRecord[]) => {
    let changed = false;
    const next = records.map((record) => {
      if (!record.streamUrl) return record;
      const cached = pluginUiCacheRef.current.get(record.streamUrl);
      if (!cached) return record;
      if (cached.payload === record.payload) return record;
      changed = true;
      return { ...record, payload: cached.payload };
    });
    return { records: next, changed };
  }, []);
  const normalizeIncomingRequest = useCallback((item: RequestData): RequestData => {
    if (!item.metadata.pluginUi) return item;
    const result = applyPluginUiDynamic(item.metadata.pluginUi.records);
    if (!result.changed) return item;
    return {
      ...item,
      metadata: {
        ...item.metadata,
        pluginUi: {
          ...item.metadata.pluginUi,
          records: result.records,
          version: (item.metadata.pluginUi.version ?? 0) + 1,
        },
      },
    };
  }, [applyPluginUiDynamic]);

  const subscribePluginUiStreams = useCallback((records: PluginUiRecord[]) => {
    for (const record of records) {
      if (!record.streamUrl) continue;
      if (pluginUiSubscribedRef.current.has(record.streamUrl)) continue;
      const unsub = stream.subscribe(record.streamUrl, (data) => {
        const payload = sanitizePluginUiPayload(data.payload);
        pluginUiCacheRef.current.set(record.streamUrl!, { payload, updatedAt: data.updatedAt });
        setRequests((prev) => prev.map(normalizeIncomingRequest));
        setSelectedDetail((prev) => (prev ? normalizeIncomingRequest(prev) : prev));
      });
      pluginUiSubsRef.current.set(record.streamUrl, { unsub });
      pluginUiSubscribedRef.current.add(record.streamUrl);
    }
  }, [normalizeIncomingRequest, stream]);

  const unsubscribeAllPluginUiStreams = useCallback(() => {
    for (const entry of pluginUiSubsRef.current.values()) {
      entry.unsub();
    }
    pluginUiSubsRef.current.clear();
    pluginUiSubscribedRef.current.clear();
  }, []);
  const navigate = useNavigate();
  const applyingSearchRef = useRef(false);
  const [requests, setRequests] = useState<RequestData[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const totalCountRef = useRef(0);
  useEffect(() => {
    totalCountRef.current = totalCount;
  }, [totalCount]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  const [selectedDetail, setSelectedDetail] = useState<RequestData | null>(null);
  const [detailNotFound, setDetailNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pagesParam, setPagesParamState] = useState<string | undefined>(undefined);
  const pagesParamRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    pagesParamRef.current = pagesParam;
  }, [pagesParam]);
  const [pageSize, setPageSizeState] = useState(20);
  const pageSizeRef = useRef(20);
  useEffect(() => {
    pageSizeRef.current = pageSize;
  }, [pageSize]);
  /** 当前显示的请求中最大的 ID */
  const maxDisplayedIdRef = useRef<number>(0);
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

  /** 加载指定页的数据（前端页码：1=最老，N=最新）*/
  const loadPages = useCallback(
    async (pages: number[]) => {
      const currentPageSize = pageSize;

      // 标记正在加载（页面切换加载，保留现有数据）
      setPageLoading(true);

      try {
        // 并行加载所有需要的页（不使用缓存，每次都从后端加载）
        const results = await Promise.all(
          pages.map(async (page) => {
            const response = await fetch(
              `/api/requests?page=${page}&limit=${currentPageSize}&order=asc`,
            );
            const data = (await response.json()) as {
              items: RequestData[];
              total: number;
              page: number;
              limit: number;
              totalPages: number;
            };
            return { page, data };
          }),
        );

        // 构建 requests 数据
        const allData: RequestData[] = [];
        for (const { page, data } of results) {
          // 后端返回 order=asc（旧的在前），反转让新的在前（与显示顺序一致）
          const normalized = data.items.map((item) => normalizeIncomingRequest(item)).reverse();
          // pages 是降序的（如 [4,3]），按此顺序拼接
          allData.push(...normalized);
          // 订阅 pluginUi streams
          for (const item of normalized) {
            const records = item.metadata.pluginUi?.records;
            if (records) subscribePluginUiStreams(records);
          }
          // 更新 totalCount（取最新的值）
          setTotalCount(data.total);
          totalCountRef.current = data.total;
        }

        setRequests(allData);
        // 更新最大显示 ID
        if (allData.length > 0) {
          const maxId = Math.max(...allData.map((r) => parseInt(r.id, 10)));
          maxDisplayedIdRef.current = maxId;
        }
      } catch (error) {
        console.error("Failed to load pages:", error);
      } finally {
        setPageLoading(false);
        setLoading(false);
      }
    },
    [pageSize, normalizeIncomingRequest, subscribePluginUiStreams],
  );

  /** 初始加载：只获取 totalCount，数据由 RequestList 的 useEffect 加载 */
  const loadRequests = useCallback(async () => {
    unsubscribeAllPluginUiStreams();
    // 不清空 requests，让 WebSocket 推送的数据可以先显示
    setLoading(true);

    try {
      // 只获取总数
      const response = await fetch("/api/requests/count");
      const data = (await response.json()) as { total: number };

      // 设置 totalCount，触发 RequestList 的 useEffect 加载数据
      setTotalCount(data.total);
      totalCountRef.current = data.total;
      
      // 如果没有数据，直接结束加载
      if (data.total === 0) {
        setRequests([]);
        setLoading(false);
      }
      // 有数据时，loading 状态由 loadPages 控制
    } catch (error) {
      console.error("Failed to load requests:", error);
      setLoading(false);
    }
  }, [unsubscribeAllPluginUiStreams]);

  const handleClearAll = useCallback(async () => {
    try {
      const response = await fetch("/api/clear", { method: "POST" });
      if (response.ok) {
        setRequests([]);
        setTotalCount(0);
        totalCountRef.current = 0;
        maxDisplayedIdRef.current = 0;
        setSelectedId(null);
        setSelectedDetail(null);
        setPagesParamState(undefined);
        unsubscribeAllPluginUiStreams();
      }
    } catch (error) {
      console.error("Failed to clear requests:", error);
    }
  }, [unsubscribeAllPluginUiStreams]);

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
      setDetailNotFound(false);

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
        if (!response.ok) {
          setDetailNotFound(true);
          return;
        }
        const data = (await response.json()) as RequestData;
        const normalized = data ? normalizeIncomingRequest(data) : data;
        setSelectedDetail(normalized);
        const records = normalized?.metadata?.pluginUi?.records;
        if (records) subscribePluginUiStreams(records);
      } catch (error) {
        console.error("Failed to load request detail:", error);
        setDetailNotFound(true);
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

  const setPagesParam = useCallback(
    (value: string) => {
      setPagesParamState(value);
      if (!applyingSearchRef.current && window.location.pathname === "/") {
        updateSearch(
          (prev) => ({
            ...prev,
            pages: value,
          }),
          { replace: true },
        );
      }
    },
    [updateSearch],
  );
  const setPageSize = useCallback(
    (value: number) => {
      const size = Math.max(1, Math.min(100, value));
      setPageSizeState(size);
      setPagesParamState(undefined); // 重置分页
      if (!applyingSearchRef.current && window.location.pathname === "/") {
        updateSearch(
          (prev) => ({
            ...prev,
            pageSize: String(size),
            pages: undefined,
          }),
          { replace: true },
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
      setPagesParamState(undefined); // 重置分页到动态模式
      if (!applyingSearchRef.current) {
        updateSearch((prev) => ({
          ...prev,
          filterMethod: method || undefined,
          pages: undefined,
        }));
      }
    },
    [updateSearch],
  );

  const setFilterStatus = useCallback(
    (status: string) => {
      setFilterStatusState(status);
      setPagesParamState(undefined);
      if (!applyingSearchRef.current) {
        updateSearch((prev) => ({
          ...prev,
          filterStatus: status || undefined,
          pages: undefined,
        }));
      }
    },
    [updateSearch],
  );

  const setFilterUrl = useCallback(
    (url: string) => {
      setFilterUrlState(url);
      setPagesParamState(undefined);
      if (!applyingSearchRef.current) {
        updateSearch((prev) => ({
          ...prev,
          filterUrl: url || undefined,
          pages: undefined,
        }));
      }
    },
    [updateSearch],
  );

  const setFilterRule = useCallback(
    (rule: string) => {
      setFilterRuleState(rule);
      setPagesParamState(undefined);
      if (!applyingSearchRef.current) {
        updateSearch((prev) => ({
          ...prev,
          filterRule: rule || undefined,
          pages: undefined,
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
      setPagesParamState(search.pages);
      if (search.pageSize) {
        const size = parseInt(search.pageSize, 10);
        if (!isNaN(size) && size > 0) {
          setPageSizeState(Math.max(1, Math.min(100, size)));
        }
      }
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

  // 防止 React Strict Mode 重复初始化
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    loadRequests();
    loadRules();
    reloadInstances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            const normalized = normalizeIncomingRequest(message.data as RequestData);
            const newId = parseInt(normalized.id, 10);
            
            // 增加 totalCount
            setTotalCount((prev) => prev + 1);
            totalCountRef.current += 1;
            
            // 判断是否在显示最新页（动态模式：anchor=-1 或 undefined）
            const currentPagesParam = pagesParamRef.current;
            const isShowingLatest = !currentPagesParam || currentPagesParam.startsWith("-1,");
            
            if (isShowingLatest) {
              const currentMaxId = maxDisplayedIdRef.current;
              const expectedId = currentMaxId + 1;
              
              if (currentMaxId === 0 || newId === expectedId) {
                // ID 连续，直接插入
                setRequests((prev) => [normalized, ...prev]);
                maxDisplayedIdRef.current = newId;
              } else if (newId > expectedId) {
                // ID 不连续，有缺失数据，加载缺失的请求
                const startId = expectedId;
                const endId = newId - 1;
                fetch(`/api/requests/range?start=${startId}&end=${endId}`)
                  .then((res) => res.json())
                  .then((missingData: RequestData[]) => {
                    const missingNormalized = missingData.map((item) => normalizeIncomingRequest(item));
                    setRequests((prev) => {
                      // 检查哪些数据还未存在
                      const existingIds = new Set(prev.map((r) => r.id));
                      const toInsert: RequestData[] = [];
                      
                      // 检查新请求是否已存在
                      if (!existingIds.has(normalized.id)) {
                        toInsert.push(normalized);
                      }
                      
                      // 检查缺失数据是否已存在（按 ID 降序）
                      for (const item of missingNormalized) {
                        if (!existingIds.has(item.id)) {
                          toInsert.push(item);
                        }
                      }
                      
                      if (toInsert.length === 0) {
                        return prev;
                      }
                      
                      return [...toInsert, ...prev];
                    });
                    maxDisplayedIdRef.current = Math.max(maxDisplayedIdRef.current, newId);
                    // 订阅缺失数据的 pluginUi streams
                    for (const item of missingNormalized) {
                      const records = item.metadata.pluginUi?.records;
                      if (records) subscribePluginUiStreams(records);
                    }
                  })
                  .catch((error) => {
                    console.error("Failed to load missing requests:", error);
                    // 降级：直接插入新请求（如果不存在）
                    setRequests((prev) => {
                      if (prev.some((r) => r.id === normalized.id)) {
                        return prev;
                      }
                      return [normalized, ...prev];
                    });
                    maxDisplayedIdRef.current = Math.max(maxDisplayedIdRef.current, newId);
                  });
              } else {
                // newId <= currentMaxId，可能是重复或乱序，忽略
              }
            }
            // 如果不是显示最新页（pinned 到某旧页），不修改 requests，只更新 totalCount
            
            const records = normalized.metadata.pluginUi?.records;
            if (records) subscribePluginUiStreams(records);
          } else if (message.type === "update-request" && message.data) {
            const updatedId = String(message.id);
            const normalized = normalizeIncomingRequest(message.data as RequestData);
            setRequests((prev) => prev.map((req) => (req.id === updatedId ? normalized : req)));
            const records = normalized.metadata.pluginUi?.records;
            if (records) subscribePluginUiStreams(records);

            setSelectedDetail((prev) => {
              if (prev && prev.id === updatedId) {
                return { ...prev, ...normalized };
              }
              return prev;
            });
          } else if (message.type === "delete-request" && message.id) {
            const deletedId = String(message.id);
            // 减少 totalCount
            setTotalCount((prev) => Math.max(0, prev - 1));
            totalCountRef.current = Math.max(0, totalCountRef.current - 1);
            setRequests((prev) => prev.filter((req) => req.id !== deletedId));
            if (selectedIdRef.current === deletedId) {
              setSelectedId(null);
              setSelectedDetail(null);
            }
          } else if (message.type === "clear-all") {
            setRequests([]);
            setTotalCount(0);
            totalCountRef.current = 0;
            maxDisplayedIdRef.current = 0;
            setSelectedId(null);
            setSelectedDetail(null);
            setPagesParamState(undefined);
            unsubscribeAllPluginUiStreams();
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
  }, [fetchConfig, livePush, loadRules, reloadInstances, subscribePluginUiStreams, normalizeIncomingRequest, unsubscribeAllPluginUiStreams]);

  useEffect(() => {
    return () => {
      unsubscribeAllPluginUiStreams();
    };
  }, [unsubscribeAllPluginUiStreams]);

  const value: ProxyViewerContextValue = {
    requests,
    totalCount,
    loading,
    pageLoading,
    pagesParam,
    setPagesParam,
    pageSize,
    setPageSize,
    loadPages,
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
    detailNotFound,
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
