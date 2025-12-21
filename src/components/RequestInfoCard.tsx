import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Heart, XOctagon, Plug, Zap } from "lucide-react";
import { RequestDetailPluginUi } from "@/components/RequestDetailPluginUi";
import type { RequestData } from "@/components/ProxyViewerContext";

export function RequestInfoCard({ metadata }: { metadata: RequestData["metadata"] }) {
  const pluginInfo = metadata?.pluginInfo;
  const pluginUi = metadata?.pluginUi;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Request</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-[120px_1fr] gap-4">
          <div className="text-muted-foreground text-sm font-medium">Method</div>
          <div className="text-sm">{metadata?.request?.method || "N/A"}</div>

          <div className="text-muted-foreground text-sm font-medium">Proxy URL</div>
          <div className="font-mono text-sm break-all">
            {metadata?.originUrl || metadata?.request?.url || "N/A"}
          </div>

          <div className="text-muted-foreground text-sm font-medium">Target URL</div>
          <div className="font-mono text-sm break-all">{metadata?.targetUrl || "N/A"}</div>

          <div className="text-muted-foreground text-sm font-medium">Time</div>
          <div className="text-sm">
            {metadata?.timestamp ? new Date(metadata.timestamp).toLocaleString() : "N/A"}
          </div>

          {pluginInfo && (
            <>
              <div className="text-muted-foreground text-sm font-medium">Plugin</div>
              <div className="flex flex-wrap items-center gap-2">
                {pluginInfo.requestType === "ping" && (
                  <Badge className="flex items-center gap-1 border-pink-500/20 bg-pink-500/10 text-xs text-pink-700">
                    <Heart className="h-3 w-3" />
                    <span>心跳请求</span>
                    {pluginInfo.pingCount && <span>#{pluginInfo.pingCount}</span>}
                  </Badge>
                )}
                {pluginInfo.requestType === "session-cancelled" && (
                  <Badge className="flex items-center gap-1 border-orange-500/20 bg-orange-500/10 text-xs text-orange-700">
                    <XOctagon className="h-3 w-3" />
                    <span>会话已取消</span>
                  </Badge>
                )}
                {pluginInfo.pluginOrigin && (
                  <Badge className="flex items-center gap-1 border-purple-500/20 bg-purple-500/10 text-xs text-purple-700">
                    <Zap className="h-3 w-3" />
                    <span>来源: {pluginInfo.pluginOrigin}</span>
                  </Badge>
                )}
                {pluginInfo.pluginsProcessed && pluginInfo.pluginsProcessed.length > 0 && (
                  <Badge className="flex items-center gap-1 border-cyan-500/20 bg-cyan-500/10 text-xs text-cyan-700">
                    <Plug className="h-3 w-3" />
                    <span>处理: {pluginInfo.pluginsProcessed.join(", ")}</span>
                  </Badge>
                )}
                {pluginInfo.sessionId && (
                  <span className="font-mono text-xs text-muted-foreground">
                    Session: {pluginInfo.sessionId.slice(0, 8)}...
                  </span>
                )}
              </div>
            </>
          )}
          {pluginUi?.records?.length ? (
            <div className="col-span-2">
              <RequestDetailPluginUi key={pluginUi.version} records={pluginUi.records} />
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
