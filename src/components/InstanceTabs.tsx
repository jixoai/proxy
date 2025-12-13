import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProxyViewer } from "@/components/ProxyViewerContext";

export function InstanceTabs() {
  const { requests, instances, activeInstanceName, setActiveInstanceName } = useProxyViewer();

  // 统计每个实例的请求数
  const instanceRequestCounts = useMemo(() => {
    const counts = new Map<string, number>();

    requests.forEach((req) => {
      const instanceName = req.metadata.instanceName || "unknown";
      counts.set(instanceName, (counts.get(instanceName) || 0) + 1);
    });

    return counts;
  }, [requests]);

  const allRequestsCount = requests.length;

  const handleTabChange = (value: string) => {
    if (value === "all") {
      setActiveInstanceName(null);
    } else {
      setActiveInstanceName(value);
    }
  };

  const currentValue = activeInstanceName === null ? "all" : activeInstanceName;

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
          const count = instanceRequestCounts.get(instance.name) || 0;
          return (
            <TabsTrigger className="shrink-0 grow-0" key={instance.name} value={instance.name}>
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
