import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, getStatusClass } from "@/components/utils";
import type { RequestData } from "@/components/ProxyViewerContext";

export function ResponseInfoCard({ metadata }: { metadata: RequestData["metadata"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Response</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-[120px_1fr] gap-4">
          <div className="text-muted-foreground text-sm font-medium">Status</div>
          <div className="text-sm">
            <span
              className={`rounded px-2 py-0.5 font-medium ${
                getStatusClass(metadata?.response?.statusCode || 0) === "success"
                  ? "bg-emerald-500/10 text-emerald-500"
                  : getStatusClass(metadata?.response?.statusCode || 0) === "redirect"
                    ? "bg-amber-500/10 text-amber-500"
                    : "bg-red-500/10 text-red-500"
              }`}
            >
              {metadata?.response?.statusCode || "N/A"} {metadata?.response?.statusMessage || ""}
            </span>
          </div>

          <div className="text-muted-foreground text-sm font-medium">Duration</div>
          <div className="text-sm">{metadata?.duration || "N/A"}</div>

          <div className="text-muted-foreground text-sm font-medium">Size</div>
          <div className="text-sm">{formatBytes(metadata?.response?.bodySize || 0)}</div>
        </div>
      </CardContent>
    </Card>
  );
}
