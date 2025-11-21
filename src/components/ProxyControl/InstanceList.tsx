import { useEffect, useState, useRef } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Server } from "lucide-react";
import { InstanceControls } from "./InstanceControls";
import type { ProxyInstance } from "@/types/proxy";
import { useProxyViewer } from "@/components/ProxyViewerContext";

interface InstanceListProps {
  instances: ProxyInstance[];
  onUpdate: () => void;
  focusedInstanceId?: number | null;
  focusedForwardId?: number | null;
}

interface InstanceStatus {
  running: boolean;
  pid?: number;
  port: number;
  listeningPort?: number;
  uptime?: number;
}

export function InstanceList({
  instances,
  onUpdate,
  focusedInstanceId,
  focusedForwardId,
}: InstanceListProps) {
  const [statuses, setStatuses] = useState<Record<number, InstanceStatus>>({});
  const [openItems, setOpenItems] = useState<string[]>([]);
  const hasInitialized = useRef(false);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const { clearControlFocus } = useProxyViewer();

  const loadStatuses = async () => {
    try {
      const response = await fetch("/api/instances/statuses");
      const data: Array<{ instanceId: number } & InstanceStatus> =
        await response.json();

      const next: Record<number, InstanceStatus> = {};
      for (const item of data) {
        next[item.instanceId] = {
          running: item.running,
          pid: item.pid,
          port: item.port,
          listeningPort: item.listeningPort,
          uptime: item.uptime,
        };
      }

      setStatuses(next);
    } catch (error) {
      console.error("Failed to load instance statuses:", error);
    }
  };

  useEffect(() => {
    loadStatuses();
    const timer = setInterval(loadStatuses, 2000);
    return () => clearInterval(timer);
  }, []);

  // 初始化或更新打開的面板
  useEffect(() => {
    if (hasInitialized.current) return;
    if (instances.length > 0) {
      const first = instances[0];
      if (first && first.id != null) {
        setOpenItems([`instance-${first.id}`]);
        hasInitialized.current = true;
      }
    }
  }, [instances]);

  useEffect(() => {
    if (!focusedInstanceId) return;
    const key = `instance-${focusedInstanceId}`;
    setOpenItems((prev) =>
      prev.includes(key) ? prev : [...prev, key],
    );
    const target = itemRefs.current.get(focusedInstanceId);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [focusedInstanceId]);

  // 在需要跳轉到特定實例時，自動展開對應面板
  useEffect(() => {
    if (!focusedInstanceId) return;
    const key = `instance-${focusedInstanceId}`;
    setOpenItems((prev) =>
      prev.includes(key) ? prev : [...prev, key],
    );
  }, [focusedInstanceId]);

  return (
    <Accordion
      type="multiple"
      className="space-y-4"
      value={openItems}
      onValueChange={(values) =>
        setOpenItems(Array.isArray(values) ? values : [])
      }
    >
      {instances.map((instance) => {
        const status =
          instance.id !== undefined ? statuses[instance.id] : undefined;

        return (
          <div
            key={instance.id}
            ref={(el) => {
              if (instance.id !== undefined && el) {
                itemRefs.current.set(instance.id, el);
              }
            }}
          >
            <AccordionItem
              value={`instance-${instance.id}`}
              className="border rounded-lg"
            >
            <div className="flex items-center gap-3 px-4">
              <AccordionTrigger className="hover:no-underline flex-1 py-4">
                <div className="flex items-center gap-3 flex-1">
                  <Server className="w-5 h-5 text-muted-foreground" />
                  <div className="flex items-center gap-2">
                    {status?.running && (
                      <span
                        className="inline-block w-2 h-2 rounded-full bg-emerald-500"
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
                  focusedForwardId={focusedForwardId}
                />
              </AccordionContent>
            </AccordionItem>
          </div>
        );
      })}
    </Accordion>
  );
}
