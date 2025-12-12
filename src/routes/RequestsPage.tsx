import { useEffect } from "react";
import { useSearch } from "@tanstack/react-router";
import { InstanceTabs } from "@/components/InstanceTabs";
import { HeaderBar } from "@/components/HeaderBar";
import { RequestList } from "@/components/RequestList";
import { RequestDetail } from "@/components/RequestDetail";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useProxyViewer } from "@/components/ProxyViewerContext";

export function RequestsPage() {
  const search = useSearch({ from: "/" });
  const { selectedId, selectRequest, applySearchState } = useProxyViewer();

  useEffect(() => {
    applySearchState(search);
  }, [applySearchState, search]);

  return (
    <div className="flex h-full flex-col">
      <InstanceTabs />
      <div className="bg-background/95 supports-[backdrop-filter]:bg-background/60 border-b backdrop-blur">
        <div className="px-4 py-3">
          <HeaderBar />
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <RequestList />
      </div>
      <Sheet open={!!selectedId} onOpenChange={(open) => !open && selectRequest(null)}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto sm:max-w-3xl lg:max-w-5xl xl:max-w-7xl"
        >
          <SheetHeader>
            <SheetTitle>请求详情</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-4">
            <RequestDetail />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
