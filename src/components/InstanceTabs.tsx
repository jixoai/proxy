import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProxyViewer } from "@/components/ProxyViewerContext";

export function InstanceTabs() {
  const { requests, instances, activeInstanceId, setActiveInstanceId } = useProxyViewer();

  // 统计每个实例的请求数
  const instanceRequestCounts = useMemo(() => {
    const counts = new Map<number, number>();

    requests.forEach((req) => {
      const instanceId = req.metadata.instanceId;
      counts.set(instanceId, (counts.get(instanceId) || 0) + 1);
    });

    return counts;
  }, [requests]);

  const allRequestsCount = requests.length;

  const handleTabChange = (value: string) => {
    if (value === "all") {
      setActiveInstanceId(null);
    } else {
      setActiveInstanceId(Number(value));
    }
  };

  const currentValue = activeInstanceId === null ? "all" : String(activeInstanceId);

  return (
    <Tabs value={currentValue} onValueChange={handleTabChange}>
      <TabsList className="w-full justify-start">
        <TabsTrigger className="shrink-0 grow-0" value="all">
          所有实例
          <Badge variant="secondary" className="ml-2">
            {allRequestsCount}
          </Badge>
        </TabsTrigger>
        {instances.map((instance) => {
          if (typeof instance.id !== "number") return null;
          const count = instanceRequestCounts.get(instance.id) || 0;
          return (
            <TabsTrigger className="shrink-0 grow-0" key={instance.id} value={String(instance.id)}>
              {instance.name}
              <Badge variant="secondary" className="ml-2">
                {count}
              </Badge>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
