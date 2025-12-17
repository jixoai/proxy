import { useEffect, useRef, useState } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Server } from "lucide-react";
import { InstanceControls } from "./InstanceControls";
import type { ProxyInstanceConfig } from "@/types/proxy";
import { useProxyViewer } from "@/components/ProxyViewerContext";

interface InstanceListProps {
  instances: ProxyInstanceConfig[];
  onUpdate: () => void;
  focusedInstanceName?: string | null;
  focusedForwardName?: string | null;
}

export function InstanceList({
  instances,
  onUpdate,
  focusedInstanceName,
  focusedForwardName,
}: InstanceListProps) {
  const [openItems, setOpenItems] = useState<string[]>([]);
  const hasInitialized = useRef(false);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const { clearControlFocus, instanceStatuses } = useProxyViewer();

  // 初始化或更新打開的面板
  useEffect(() => {
    if (hasInitialized.current) return;
    if (instances.length > 0) {
      const first = instances[0];
      if (first) {
        setOpenItems([`instance-${first.name}`]);
        hasInitialized.current = true;
      }
    }
  }, [instances]);

  useEffect(() => {
    if (!focusedInstanceName) return;
    const key = `instance-${focusedInstanceName}`;
    setOpenItems((prev) => (prev.includes(key) ? prev : [...prev, key]));
    const target = itemRefs.current.get(focusedInstanceName);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [focusedInstanceName]);

  // 在需要跳轉到特定實例時，自動展開對應面板
  useEffect(() => {
    if (!focusedInstanceName) return;
    const key = `instance-${focusedInstanceName}`;
    setOpenItems((prev) => (prev.includes(key) ? prev : [...prev, key]));
  }, [focusedInstanceName]);

  return (
    <Accordion
      type="multiple"
      className="space-y-4"
      value={openItems}
      onValueChange={(values) => setOpenItems(Array.isArray(values) ? values : [])}
    >
      {instances.map((instance) => {
        const status = instanceStatuses[instance.name];

        return (
          <div
            key={instance.name}
            ref={(el) => {
              if (el) {
                itemRefs.current.set(instance.name, el);
              }
            }}
          >
            <AccordionItem value={`instance-${instance.name}`} className="rounded-lg border">
              <div className="flex items-center gap-3 px-4">
                <AccordionTrigger className="flex-1 py-4 hover:no-underline">
                  <div className="flex flex-1 items-center gap-3">
                    <Server className="text-muted-foreground h-5 w-5" />
                    <div className="flex items-center gap-2">
                      {status?.running && (
                        <span
                          className="inline-block h-2 w-2 rounded-full bg-emerald-500"
                          aria-hidden="true"
                        />
                      )}
                      <span className="font-semibold">{instance.name}</span>
                      <Badge variant="outline" className="text-xs">
                        :{instance.port}
                      </Badge>
                      <Badge
                        variant={status?.running ? "default" : "secondary"}
                        className="text-[10px]"
                      >
                        {status?.running ? "监听中" : "未启动"}
                      </Badge>
                    </div>
                  </div>
                </AccordionTrigger>
              </div>
              <AccordionContent className="px-4 pt-4">
                <InstanceControls
                  instance={instance}
                  onUpdate={onUpdate}
                  focusedForwardName={
                    focusedInstanceName === instance.name ? focusedForwardName : null
                  }
                />
              </AccordionContent>
            </AccordionItem>
          </div>
        );
      })}
    </Accordion>
  );
}
