import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RequestData } from "@/components/ProxyViewerContext";

export function RequestInfoCard({ metadata }: { metadata: RequestData["metadata"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Request</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-[120px_1fr] gap-4">
          <div className="text-sm font-medium text-muted-foreground">
            Method
          </div>
          <div className="text-sm">
            {metadata?.request?.method || "N/A"}
          </div>

          <div className="text-sm font-medium text-muted-foreground">
            Proxy URL
          </div>
          <div className="text-sm font-mono break-all">
            {metadata?.originUrl || metadata?.request?.url || "N/A"}
          </div>

          <div className="text-sm font-medium text-muted-foreground">
            Target URL
          </div>
          <div className="text-sm font-mono break-all">
            {metadata?.targetUrl || "N/A"}
          </div>

          <div className="text-sm font-medium text-muted-foreground">
            Time
          </div>
          <div className="text-sm">
            {metadata?.timestamp
              ? new Date(metadata.timestamp).toLocaleString()
              : "N/A"}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
