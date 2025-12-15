import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Radio, RefreshCw, Trash2, X } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useProxyViewer } from "@/components/ProxyViewerContext";
import { useMemo } from "react";

export function HeaderBar() {
  const {
    requests,
    livePush,
    setLivePush,
    wsConnected,
    filterMethod,
    setFilterMethod,
    filterStatus,
    setFilterStatus,
    filterUrl,
    setFilterUrl,
    setCurrentPage,
    loadRequests,
    handleClearAll,
    availableRules,
    activeRuleName,
    setActiveRuleName,
  } = useProxyViewer();

  const uniqueAvailableRules = useMemo(() => {
    const seen = new Set<string>();
    return availableRules.filter((rule) => {
      const value = `${rule.instanceName}/${rule.name}`;
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }, [availableRules]);

  // 计算过滤后的请求数
  const filteredCount = requests.filter((req) => {
    if (filterMethod && req.metadata.request.method !== filterMethod) return false;
    if (filterStatus) {
      const statusCode = req.metadata.response?.statusCode?.toString() || "";
      if (statusCode !== filterStatus) return false;
    }
    if (filterUrl && !req.metadata.request.url.toLowerCase().includes(filterUrl.toLowerCase()))
      return false;
    return true;
  }).length;

  return (
    <header className="bg-card w-full">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-muted-foreground text-xs">
            {filteredCount} / {requests.length} requests
          </p>
        </div>
        <div className="flex items-center gap-2">
          {wsConnected && (
            <span className="inline-flex items-center gap-1 text-xs text-green-500">
              <Radio className="h-3 w-3 animate-pulse" />
              Live
            </span>
          )}
          <div className="flex items-center gap-1">
            <Switch checked={livePush} onCheckedChange={setLivePush} />
            <span className="text-xs text-muted-foreground">Push</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => loadRequests()}>
            <RefreshCw className="mr-1 h-4 w-4" />
            Refresh
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm">
                <Trash2 className="mr-1 h-4 w-4" />
                Clear All
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>确定要清空所有代理记录吗？</AlertDialogTitle>
                <AlertDialogDescription>
                  此操作将永久删除所有代理请求记录，此操作不可撤销。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={handleClearAll}>确认清空</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 text-sm">
        <Select
          value={filterMethod || "all"}
          onValueChange={(value) => {
            setFilterMethod(value === "all" ? "" : value);
            setCurrentPage(1);
          }}
        >
          <SelectTrigger className="w-[140px]" size="sm">
            <SelectValue placeholder="All Methods" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Methods</SelectItem>
            <SelectItem value="GET">GET</SelectItem>
            <SelectItem value="POST">POST</SelectItem>
            <SelectItem value="PUT">PUT</SelectItem>
            <SelectItem value="DELETE">DELETE</SelectItem>
            <SelectItem value="PATCH">PATCH</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filterStatus || "all"}
          onValueChange={(value) => {
            setFilterStatus(value === "all" ? "" : value);
            setCurrentPage(1);
          }}
        >
          <SelectTrigger className="w-[130px]" size="sm">
            <SelectValue placeholder="All Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="200">200</SelectItem>
            <SelectItem value="201">201</SelectItem>
            <SelectItem value="204">204</SelectItem>
            <SelectItem value="301">301</SelectItem>
            <SelectItem value="302">302</SelectItem>
            <SelectItem value="304">304</SelectItem>
            <SelectItem value="400">400</SelectItem>
            <SelectItem value="401">401</SelectItem>
            <SelectItem value="403">403</SelectItem>
            <SelectItem value="404">404</SelectItem>
            <SelectItem value="500">500</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={activeRuleName || "all"}
          onValueChange={(value) => {
            setActiveRuleName(value === "all" ? null : value);
            setCurrentPage(1);
          }}
        >
          <SelectTrigger className="w-[160px]" size="sm">
            <SelectValue placeholder="All Rules" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部规则</SelectItem>
            {uniqueAvailableRules.map((rule) => {
              const value = `${rule.instanceName}/${rule.name}`;
              return (
                <SelectItem key={value} value={value}>
                  {rule.name}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>

        <Input
          type="text"
          placeholder="Filter URL..."
          className="flex-1"
          value={filterUrl}
          onChange={(e) => {
            setFilterUrl(e.target.value);
            setCurrentPage(1);
          }}
        />

        {(filterMethod || filterStatus || filterUrl || activeRuleName) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFilterMethod("");
              setFilterStatus("");
              setFilterUrl("");
              setActiveRuleName(null);
              setCurrentPage(1);
            }}
          >
            <X className="mr-1 h-4 w-4" />
            Clear Filters
          </Button>
        )}
      </div>
    </header>
  );
}
