import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function HeadersCard({
  title,
  headers,
  originalHeaders,
}: {
  title: string;
  headers: Record<string, string>;
  originalHeaders?: Record<string, string>;
}) {
  if (Object.keys(headers).length === 0) {
    return null;
  }

  // 计算 diff 状态（header keys 是大小写不敏感的）
  const getDiffStatus = (
    key: string,
    value: string,
  ): "added" | "modified" | "unchanged" | "deleted" => {
    if (!originalHeaders) return "unchanged";

    // 使用小写进行比较，因为 HTTP headers 是大小写不敏感的
    const keyLower = key.toLowerCase();
    const originalEntry = Object.entries(originalHeaders).find(
      ([k]) => k.toLowerCase() === keyLower,
    );

    if (!originalEntry) {
      return "added"; // 新增字段
    }

    const [originalKey, originalValue] = originalEntry;
    if (originalValue !== value) {
      return "modified"; // 被覆盖
    }
    return "unchanged"; // 未变化
  };

  // 找到原始值（用于显示被覆盖的旧值）
  const getOriginalValue = (key: string): string | undefined => {
    if (!originalHeaders) return undefined;
    const keyLower = key.toLowerCase();
    const originalEntry = Object.entries(originalHeaders).find(
      ([k]) => k.toLowerCase() === keyLower,
    );
    return originalEntry?.[1];
  };

  // 找出被删除的字段（在 original 中存在但在当前 headers 中不存在）
  const deletedHeaders = originalHeaders
    ? Object.entries(originalHeaders).filter(([originalKey]) => {
        const keyLower = originalKey.toLowerCase();
        return !Object.keys(headers).some((k) => k.toLowerCase() === keyLower);
      })
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="bg-muted rounded-lg p-4 font-mono text-sm space-y-2 max-h-[400px] overflow-auto">
          {Object.entries(headers).map(([key, value]) => {
            const status = getDiffStatus(key, value);
            return (
              <div
                key={key}
                className="grid grid-cols-[150px_1fr] gap-2 border-b border-border/40 pb-2 last:border-0"
              >
                <div className="text-muted-foreground font-medium text-xs flex items-center gap-2">
                  <span>{key}</span>
                  {status === "added" && (
                    <Badge
                      variant="outline"
                      className="text-[10px] bg-green-500/10 text-green-700 border-green-500/20 px-1 py-0"
                    >
                      +
                    </Badge>
                  )}
                  {status === "modified" && (
                    <Badge
                      variant="outline"
                      className="text-[10px] bg-yellow-500/10 text-yellow-700 border-yellow-500/20 px-1 py-0"
                    >
                      ~
                    </Badge>
                  )}
                </div>
                <div
                  className={`break-all text-xs ${
                    status === "added"
                      ? "text-green-700 font-medium"
                      : status === "modified"
                        ? "text-yellow-700 font-medium"
                        : ""
                  }`}
                >
                  {status === "modified" && (
                    <div className="text-red-700 line-through opacity-60 mb-1">
                      {getOriginalValue(key)}
                    </div>
                  )}
                  {value}
                </div>
              </div>
            );
          })}
          {deletedHeaders.length > 0 && (
            <>
              {deletedHeaders.map(([key, value]) => (
                <div
                  key={`deleted-${key}`}
                  className="grid grid-cols-[150px_1fr] gap-2 border-b border-border/40 pb-2 last:border-0 opacity-50"
                >
                  <div className="text-muted-foreground font-medium text-xs flex items-center gap-2">
                    <span className="line-through">{key}</span>
                    <Badge
                      variant="outline"
                      className="text-[10px] bg-red-500/10 text-red-700 border-red-500/20 px-1 py-0"
                    >
                      -
                    </Badge>
                  </div>
                  <div className="break-all text-xs text-red-700 line-through">
                    {value}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
