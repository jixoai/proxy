import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useProxyViewer, type RequestData } from "@/components/ProxyViewerContext";

interface RuleTabsProps {
  instanceId: number | null;
}

export function RuleTabs({ instanceId }: RuleTabsProps) {
  const {
    requests,
    availableRules,
    activeRuleId,
    setActiveRuleId,
  } = useProxyViewer();

  // 过滤当前实例的请求
  const instanceRequests = useMemo(() => {
    if (instanceId === null) {
      return requests;
    }
    return requests.filter((req) => {
      return req.metadata.instanceId === instanceId;
    });
  }, [requests, instanceId]);

  // 按规则分组统计
  const ruleRequestCounts = useMemo(() => {
    const counts = new Map<string, number>();

    instanceRequests.forEach((req) => {
      const ruleId = req.metadata.forwardRule?.id?.toString() || "unknown";
      counts.set(ruleId, (counts.get(ruleId) || 0) + 1);
    });

    return counts;
  }, [instanceRequests]);

  const allCount = instanceRequests.length;

  const handleTabChange = (value: string) => {
    if (value === "all") {
      setActiveRuleId(null);
    } else {
      setActiveRuleId(value);
    }
  };

  const currentValue = activeRuleId === null ? "all" : activeRuleId;

  // 过滤出有请求的规则
  const rulesWithRequests = availableRules.filter((rule) => {
    const count = ruleRequestCounts.get(rule.id.toString()) || 0;
    return count > 0;
  });

  return (
    <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <Tabs value={currentValue} onValueChange={handleTabChange}>
        <TabsList className="w-full justify-start rounded-none border-b-0 bg-transparent p-0 h-auto">
          <TabsTrigger
            value="all"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
          >
            全部
            <Badge variant="secondary" className="ml-2">
              {allCount}
            </Badge>
          </TabsTrigger>
          {rulesWithRequests.map((rule) => {
            const count = ruleRequestCounts.get(rule.id.toString()) || 0;
            return (
              <TabsTrigger
                key={rule.id}
                value={rule.id.toString()}
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
              >
                {rule.name}
                <Badge variant="secondary" className="ml-2">
                  {count}
                </Badge>
              </TabsTrigger>
            );
          })}
          {ruleRequestCounts.has("unknown") && ruleRequestCounts.get("unknown")! > 0 && (
            <TabsTrigger
              value="unknown"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
            >
              未知规则
              <Badge variant="secondary" className="ml-2">
                {ruleRequestCounts.get("unknown")}
              </Badge>
            </TabsTrigger>
          )}
        </TabsList>
      </Tabs>
    </div>
  );
}
