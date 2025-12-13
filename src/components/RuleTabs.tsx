import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProxyViewer, type RequestData } from "@/components/ProxyViewerContext";

interface RuleTabsProps {
  instanceName: string | null;
}

export function RuleTabs({ instanceName }: RuleTabsProps) {
  const { requests, availableRules, activeRuleName, setActiveRuleName } = useProxyViewer();

  // 过滤当前实例的请求
  const instanceRequests = useMemo(() => {
    if (instanceName === null) {
      return requests;
    }
    return requests.filter((req) => {
      return req.metadata.instanceName === instanceName;
    });
  }, [requests, instanceName]);

  // 按规则分组统计
  const ruleRequestCounts = useMemo(() => {
    const counts = new Map<string, number>();

    instanceRequests.forEach((req) => {
      const ruleName = req.metadata.forwardName || "unknown";
      counts.set(ruleName, (counts.get(ruleName) || 0) + 1);
    });

    return counts;
  }, [instanceRequests]);

  const allCount = instanceRequests.length;

  const handleTabChange = (value: string) => {
    if (value === "all") {
      setActiveRuleName(null);
    } else {
      setActiveRuleName(value);
    }
  };

  const currentValue = activeRuleName === null ? "all" : activeRuleName;

  // 过滤出有请求的规则
  const rulesWithRequests = availableRules.filter((rule) => {
    const count = ruleRequestCounts.get(rule.name) || 0;
    return count > 0;
  });

  return (
    <div className="bg-background/95 supports-[backdrop-filter]:bg-background/60 border-b backdrop-blur">
      <Tabs value={currentValue} onValueChange={handleTabChange}>
        <TabsList className="h-auto w-full justify-start rounded-none border-b-0 bg-transparent p-0">
          <TabsTrigger
            value="all"
            className="data-[state=active]:border-primary rounded-none border-b-2 border-transparent data-[state=active]:bg-transparent"
          >
            全部
            <Badge variant="secondary" className="ml-2">
              {allCount}
            </Badge>
          </TabsTrigger>
          {rulesWithRequests.map((rule) => {
            const count = ruleRequestCounts.get(rule.name) || 0;
            return (
              <TabsTrigger
                key={`${rule.instanceName}-${rule.name}`}
                value={rule.name}
                className="data-[state=active]:border-primary rounded-none border-b-2 border-transparent data-[state=active]:bg-transparent"
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
              className="data-[state=active]:border-primary rounded-none border-b-2 border-transparent data-[state=active]:bg-transparent"
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
