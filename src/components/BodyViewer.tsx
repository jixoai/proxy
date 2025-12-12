import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { createDefaultPlugins } from "@/plugins";
import type {
  BodyViewerPlugin,
  PluginState,
  Content,
  PluginContext,
} from "@/contexts/BodyViewerPlugin";
import { PluginManager } from "@/lib/body-viewer-plugins";

interface BodyViewerProps {
  body: Uint8Array;
  headers: Record<string, string>;
  title: string;
  emptyMessage?: string;
  plugins?: BodyViewerPlugin[];
}

/**
 * 从 body 和 headers 推导初始 Content
 */
function deriveContentFromBody(body: Uint8Array, headers: Record<string, string>): Content {
  const mime = headers["content-type"] || "application/octet-stream";
  return {
    mime,
    value: body,
  };
}

function ViewerTabs({
  viewers,
  activeViewerId,
  onSelect,
}: {
  viewers: { id: string; tab: React.ReactNode }[];
  activeViewerId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {viewers.map((viewer) => (
        <Button
          key={viewer.id}
          variant={activeViewerId === viewer.id ? "default" : "ghost"}
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={() => onSelect(viewer.id)}
        >
          {viewer.tab}
        </Button>
      ))}
      {viewers.length === 0 && (
        <span className="text-muted-foreground rounded border border-dashed px-2 py-1 text-xs">
          No viewer
        </span>
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="text-muted-foreground py-8 text-center text-sm">{message}</div>;
}

export function BodyViewer({
  body,
  headers,
  title,
  emptyMessage = "No Content",
  plugins,
}: BodyViewerProps) {
  // 合并并排序插件
  const pluginManager = useMemo(() => {
    const defaultPlugins = createDefaultPlugins();
    const finalPlugins = plugins ? [...defaultPlugins, ...plugins] : defaultPlugins;
    return new PluginManager(finalPlugins);
  }, [plugins]);

  const sortedPlugins = useMemo(() => pluginManager.getPlugins(), [pluginManager]);

  // 插件状态数组
  const [pluginStates, setPluginStates] = useState<PluginState[]>([]);
  const [activeViewerId, setActiveViewerId] = useState<string | null>(null);

  // 每个插件的动态 actions 和 tips（按插件名分组）
  const [pluginDynamicActionsMap, setPluginDynamicActionsMap] = useState<
    Map<string, Map<string, import("@/contexts/BodyViewerPlugin").ToolbarAction[]>>
  >(new Map());
  const [pluginTipsMap, setPluginTipsMap] = useState<
    Map<string, Map<string, import("@/contexts/BodyViewerPlugin").TipConfig & { id: string }>>
  >(new Map());

  // 用 ref 存储最新的执行请求，防止竞态条件
  const transformRequestId = useRef(0);

  // 创建插件专属的动态 actions 注册函数
  const createRegisterActions = useCallback((pluginName: string) => {
    return (actions: import("@/contexts/BodyViewerPlugin").ToolbarAction[]) => {
      const id = `actions-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      setPluginDynamicActionsMap((prev) => {
        const next = new Map(prev);
        const pluginActions = next.get(pluginName) || new Map();
        pluginActions.set(id, actions);
        next.set(pluginName, pluginActions);
        return next;
      });

      // 返回清理函数
      return () => {
        setPluginDynamicActionsMap((prev) => {
          const pluginActions = prev.get(pluginName);
          if (!pluginActions || !pluginActions.has(id)) return prev;

          const next = new Map(prev);
          const nextPluginActions = new Map(pluginActions);
          nextPluginActions.delete(id);

          if (nextPluginActions.size === 0) {
            next.delete(pluginName);
          } else {
            next.set(pluginName, nextPluginActions);
          }
          return next;
        });
      };
    };
  }, []);

  // 创建插件专属的 showTip 函数
  const createShowTip = useCallback((pluginName: string) => {
    return (
      tip: Omit<import("@/contexts/BodyViewerPlugin").TipConfig, "id">,
      duration?: number,
    ) => {
      const id = `tip-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const fullTip = { ...tip, id };

      setPluginTipsMap((prev) => {
        const next = new Map(prev);
        const pluginTips = next.get(pluginName) || new Map();
        pluginTips.set(id, fullTip);
        next.set(pluginName, pluginTips);
        return next;
      });

      // 自动隐藏
      if (duration && duration > 0) {
        setTimeout(() => {
          setPluginTipsMap((prev) => {
            const pluginTips = prev.get(pluginName);
            if (!pluginTips || !pluginTips.has(id)) return prev;

            const next = new Map(prev);
            const nextPluginTips = new Map(pluginTips);
            nextPluginTips.delete(id);

            if (nextPluginTips.size === 0) {
              next.delete(pluginName);
            } else {
              next.set(pluginName, nextPluginTips);
            }
            return next;
          });
        }, duration);
      }

      return id;
    };
  }, []);

  // 创建插件专属的 hideTip 函数
  const createHideTip = useCallback((pluginName: string) => {
    return (id: string) => {
      setPluginTipsMap((prev) => {
        const pluginTips = prev.get(pluginName);
        if (!pluginTips || !pluginTips.has(id)) return prev;

        const next = new Map(prev);
        const nextPluginTips = new Map(pluginTips);
        nextPluginTips.delete(id);

        if (nextPluginTips.size === 0) {
          next.delete(pluginName);
        } else {
          next.set(pluginName, nextPluginTips);
        }
        return next;
      });
    };
  }, []);

  /**
   * 执行 transform 链
   * @param initialContent 初始内容
   * @param startIndex 从哪个插件开始执行（默认 0）
   */
  const executeTransformChain = useCallback(
    async (initialContent: Content, startIndex: number = 0) => {
      const requestId = ++transformRequestId.current;

      let currentContent = initialContent;
      const newStates: PluginState[] = [];

      for (let i = startIndex; i < sortedPlugins.length; i++) {
        const plugin = sortedPlugins[i];
        if (!plugin) continue;

        // 创建插件状态
        const state: PluginState = {
          name: plugin.name,
          content: currentContent,
          viewer: null,
        };

        // 创建插件上下文（每个插件都有专属的动态函数）
        const ctx: PluginContext = {
          body,
          headers,
          content: currentContent,
          setContent: (next) => {
            const newContent = typeof next === "function" ? next(currentContent) : next;
            // 从下一个插件开始重新执行
            executeTransformChain(newContent, i + 1);
          },
          activeViewerId,
          registerViewer: (viewer) => {
            // 同步修改 state
            state.viewer = viewer;
          },
          registerActions: createRegisterActions(plugin.name),
          showTip: createShowTip(plugin.name),
          hideTip: createHideTip(plugin.name),
          getConfig: () => pluginManager.getPluginConfig(plugin.name),
          setConfig: (config) => pluginManager.setPluginConfig(plugin.name, config),
        };

        // 执行 transform
        if (plugin.transform) {
          try {
            const result = await plugin.transform(currentContent, ctx);

            // 检查是否有新的执行请求，如果有则放弃当前执行
            if (requestId !== transformRequestId.current) {
              return;
            }

            if (result !== null) {
              currentContent = result;
              state.content = currentContent;
            }
          } catch (error) {
            console.error(`[BodyViewer] Plugin "${plugin.name}" transform failed:`, error);
          }
        }

        newStates.push(state);
      }

      // 再次检查是否过期
      if (requestId !== transformRequestId.current) {
        return;
      }

      // 更新状态
      setPluginStates((prev) => {
        if (startIndex === 0) {
          return newStates;
        } else {
          // 合并前面的状态
          return [...prev.slice(0, startIndex), ...newStates];
        }
      });
    },
    [
      body,
      headers,
      sortedPlugins,
      activeViewerId,
      pluginManager,
      createRegisterActions,
      createShowTip,
      createHideTip,
    ],
  );

  // body/headers 变化时重新执行 transform 链
  useEffect(() => {
    const initialContent = deriveContentFromBody(body, headers);
    executeTransformChain(initialContent, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, headers]); // 只依赖 body 和 headers

  // 从 pluginStates 提取 viewers
  const viewers = useMemo(() => {
    return pluginStates
      .filter((state) => state.viewer !== null)
      .map((state) => ({
        id: state.name,
        ...state.viewer!,
      }));
  }, [pluginStates]);

  // 自动选择第一个 viewer
  useEffect(() => {
    if (viewers.length === 0) {
      if (activeViewerId !== null) {
        setActiveViewerId(null);
      }
      return;
    }

    const found = viewers.some((v) => v.id === activeViewerId);
    if (!found && viewers[0]) {
      setActiveViewerId(viewers[0].id);
    }
  }, [viewers, activeViewerId]);

  // 获取激活的 viewer
  const activeViewer = viewers.find((v) => v.id === activeViewerId);

  // 合并静态和动态 actions
  const allActions = useMemo(() => {
    // 静态 actions：收集所有 viewer 的静态 actions（持久显示）
    const staticActions = viewers.flatMap((v) => v.actions ?? []);

    // 动态 actions：只显示当前激活插件的动态 actions
    const dynamicActions = activeViewerId
      ? Array.from(pluginDynamicActionsMap.get(activeViewerId)?.values() ?? []).flat()
      : [];

    return [...staticActions, ...dynamicActions];
  }, [viewers, activeViewerId, pluginDynamicActionsMap]);

  // 合并静态和动态 tips（只显示当前激活插件的）
  const allTips = useMemo(() => {
    const staticTips = (activeViewer?.tips ?? []).map((tip, idx) => ({
      ...tip,
      id: `static-tip-${idx}`,
    }));

    // 获取当前激活插件的动态 tips
    const dynamicTips = activeViewerId
      ? Array.from(pluginTipsMap.get(activeViewerId)?.values() ?? [])
      : [];

    return [...staticTips, ...dynamicTips];
  }, [activeViewer, activeViewerId, pluginTipsMap]);

  return (
    <Card className="min-w-0 gap-4">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{title}</CardTitle>
          <ViewerTabs
            viewers={viewers}
            activeViewerId={activeViewerId}
            onSelect={setActiveViewerId}
          />
        </div>
      </CardHeader>
      <CardContent>
        {activeViewer ? activeViewer.content : <EmptyState message={emptyMessage} />}
      </CardContent>
      <CardFooter className="flex flex-col gap-2">
        {/* Tips */}
        {allTips.length > 0 && (
          <div className="flex w-full flex-col gap-1">
            {allTips.map((tip) => (
              <div
                key={tip.id}
                className={`rounded border px-2 py-1 text-xs ${
                  tip.type === "error"
                    ? "border-red-200 bg-red-50 text-red-700"
                    : tip.type === "warning"
                      ? "border-yellow-200 bg-yellow-50 text-yellow-700"
                      : tip.type === "success"
                        ? "border-green-200 bg-green-50 text-green-700"
                        : "border-blue-200 bg-blue-50 text-blue-700"
                }`}
              >
                {tip.content}
              </div>
            ))}
          </div>
        )}
        {/* Actions */}
        {allActions.length > 0 && (
          <div className="flex w-full items-center gap-2">
            {allActions.map((action) => (
              <div key={action.id}>{action.render()}</div>
            ))}
          </div>
        )}
      </CardFooter>
    </Card>
  );
}
