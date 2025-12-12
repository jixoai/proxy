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
        <div className="bg-muted max-h-[400px] space-y-2 overflow-auto rounded-lg p-4 font-mono text-sm">
          {Object.entries(headers).map(([key, value]) => {
            const status = getDiffStatus(key, value);
            return (
              <div
                key={key}
                className="border-border/40 grid grid-cols-[150px_1fr] gap-2 border-b pb-2 last:border-0"
              >
                <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
                  <span>{key}</span>
                  {status === "added" && (
                    <Badge
                      variant="outline"
                      className="border-green-500/20 bg-green-500/10 px-1 py-0 text-[10px] text-green-700"
                    >
                      +
                    </Badge>
                  )}
                  {status === "modified" && (
                    <Badge
                      variant="outline"
                      className="border-yellow-500/20 bg-yellow-500/10 px-1 py-0 text-[10px] text-yellow-700"
                    >
                      ~
                    </Badge>
                  )}
                </div>
                <div
                  className={`text-xs break-all ${
                    status === "added"
                      ? "font-medium text-green-700"
                      : status === "modified"
                        ? "font-medium text-yellow-700"
                        : ""
                  }`}
                >
                  {status === "modified" && (
                    <div className="mb-1 text-red-700 line-through opacity-60">
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
                  className="border-border/40 grid grid-cols-[150px_1fr] gap-2 border-b pb-2 opacity-50 last:border-0"
                >
                  <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
                    <span className="line-through">{key}</span>
                    <Badge
                      variant="outline"
                      className="border-red-500/20 bg-red-500/10 px-1 py-0 text-[10px] text-red-700"
                    >
                      -
                    </Badge>
                  </div>
                  <div className="text-xs break-all text-red-700 line-through">{value}</div>
                </div>
              ))}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
