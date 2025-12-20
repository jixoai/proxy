import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Zap, Circle } from "lucide-react";
import type { HookLayer } from "@/components/ProxyViewerContext";
import { cn } from "@/lib/utils";

interface HookLayersTabsProps {
  /** 每层 hook 的执行结果 */
  layers?: HookLayer[];
  /** 是否有最终的 hooked 数据 */
  hasHooked: boolean;
  /** 原始数据的渲染函数 */
  renderOriginal: () => React.ReactNode;
  /** hooked 数据的渲染函数 (当没有 layers 时使用) */
  renderHooked?: () => React.ReactNode;
  /** 某一层的渲染函数 (当有 layers 时使用) */
  renderLayer?: (layer: HookLayer, index: number) => React.ReactNode;
  /** 默认激活的 tab */
  defaultTab?: string;
}

/**
 * 显示多层 hooks 的 tabs 组件
 * 
 * - 如果没有 layers 且没有 hooked，直接渲染 original
 * - 如果没有 layers 但有 hooked，显示 Original/Hooked tabs
 * - 如果有 layers，显示 Original -> Plugin1 -> Plugin2 -> ... 的 tabs
 */
export function HookLayersTabs({
  layers,
  hasHooked,
  renderOriginal,
  renderHooked,
  renderLayer,
  defaultTab,
}: HookLayersTabsProps) {
  // 没有 layers 且没有 hooked，直接渲染 original
  if (!layers?.length && !hasHooked) {
    return <>{renderOriginal()}</>;
  }

  // 没有 layers 但有 hooked，使用简单的 Original/Hooked tabs
  if (!layers?.length && hasHooked && renderHooked) {
    return (
      <Tabs defaultValue={defaultTab ?? "hooked"} className="w-full">
        <TabsList>
          <TabsTrigger value="hooked" className="gap-1">
            <Zap className="h-3 w-3" />
            Hooked
          </TabsTrigger>
          <TabsTrigger value="original">Original</TabsTrigger>
        </TabsList>
        <TabsContent value="hooked">{renderHooked()}</TabsContent>
        <TabsContent value="original">{renderOriginal()}</TabsContent>
      </Tabs>
    );
  }

  // 有 layers，显示多层 tabs
  if (layers?.length && renderLayer) {
    // 找到最后一个 modified=true 的层作为默认 tab
    const lastModifiedIndex = [...layers].reverse().findIndex((l) => l.modified);
    const defaultTabValue =
      defaultTab ??
      (lastModifiedIndex >= 0
        ? `layer-${layers.length - 1 - lastModifiedIndex}`
        : "original");

    return (
      <Tabs defaultValue={defaultTabValue} className="w-full">
        <TabsList className="flex-wrap h-auto gap-1 p-1">
          <TabsTrigger value="original" className="text-xs">
            Origin
          </TabsTrigger>
          {layers.map((layer, index) => (
            <TabsTrigger
              key={index}
              value={`layer-${index}`}
              disabled={!layer.modified}
              className={cn(
                "text-xs gap-1",
                !layer.modified && "opacity-50 cursor-not-allowed"
              )}
            >
              {layer.modified ? (
                <Zap className="h-3 w-3" />
              ) : (
                <Circle className="h-3 w-3" />
              )}
              {layer.pluginName}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="original">{renderOriginal()}</TabsContent>
        {layers.map((layer, index) => (
          <TabsContent key={index} value={`layer-${index}`}>
            {layer.modified ? (
              renderLayer(layer, index)
            ) : (
              <div className="text-muted-foreground text-sm p-4 text-center">
                插件 {layer.pluginName} 未修改内容
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>
    );
  }

  // fallback
  return <>{renderOriginal()}</>;
}
