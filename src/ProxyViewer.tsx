import {
  ProxyViewerProvider,
  useProxyViewer,
} from "@/components/ProxyViewerContext";
import { HeaderBar } from "@/components/HeaderBar";
import { RequestList } from "@/components/RequestList";
import { RequestDetail } from "@/components/RequestDetail";
import { Island } from "@/components/Island";
import { JSONSelector } from "@/components/JSONSelector";
import { JSONPreviewDialog } from "@/components/JSONPreviewDialog";
import { ProxyControl } from "@/components/ProxyControl/index";
import { InstanceTabs } from "@/components/InstanceTabs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  SidebarProvider,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { Network, Settings, List } from "lucide-react";

function RequestsViewContent() {
  const { selectedId, selectRequest } = useProxyViewer();

  return (
    <>
      {/* Instance Tabs */}
      <InstanceTabs />

      {/* Header Bar */}
      <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="px-4 py-3">
          <HeaderBar />
        </div>
      </div>

      {/* Request List */}
      <div className="flex-1 overflow-hidden">
        <RequestList />
      </div>

      {/* Request Detail Sheet - 侧边抽屉 */}
      <Sheet
        open={!!selectedId}
        onOpenChange={(open) => !open && selectRequest(null)}
      >
        <SheetContent
          side="right"
          className="w-full sm:max-w-3xl lg:max-w-5xl xl:max-w-7xl overflow-y-auto"
        >
          <SheetHeader>
            <SheetTitle>请求详情</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-4">
            <RequestDetail />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
import Logo from "./logo.svg";

function ProxyViewerInner() {
  const { activeView, setActiveView } = useProxyViewer();

  return (
    <SidebarProvider>
        <div className="h-screen flex w-full bg-background">
          {/* Sidebar */}
          <Sidebar collapsible="icon" className="border-r **:ease-linear">
            <SidebarHeader className="border-b">
              <div className="flex items-center justify-between  group-data-[state=collapsed]:gap-0 group-data-[state=expanded]:gap-2 duration-200 transition-all">
                <div className="flex items-center gap-2 group-data-[state=collapsed]:w-0 group-data-[state=collapsed]:-translate-x-8 group-data-[state=collapsed]:pointer-events-none group-data-[state=collapsed]:opacity-0 group-data-[state=expanded]:opacity-100 duration-200 transition-all ">
                  <img className="size-8 min-w-8 shrink-0" src={Logo}></img>
                  <span className="font-semibold whitespace-nowrap">
                    Proxy Viewer
                  </span>
                </div>
                <SidebarTrigger className="cursor-pointer" />
              </div>
            </SidebarHeader>

            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupLabel>导航</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={activeView === "requests"}
                        onClick={() => setActiveView("requests")}
                      >
                        <List className="w-4 h-4" />
                        <span>请求列表</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        isActive={activeView === "control"}
                        onClick={() => setActiveView("control")}
                      >
                        <Settings className="w-4 h-4" />
                        <span>内核控制</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>

            <SidebarFooter className="border-t px-4 py-2">
              <div className="text-xs text-muted-foreground">
                Proxy Viewer v1.0
              </div>
            </SidebarFooter>
          </Sidebar>

          {/* Main Content */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Content Area */}
            <div className="flex-1 overflow-hidden">
              {activeView === "requests" ? (
                <div className="h-full flex flex-col">
                  <RequestsViewContent />
                </div>
              ) : (
                <div className="h-full flex flex-col">
                  {/* Proxy Control Content */}
                  <div className="flex-1 overflow-y-auto p-4 md:p-6">
                    <div className="max-w-4xl mx-auto">
                      <h1 className="text-2xl font-semibold mb-6">内核控制</h1>
                      <ProxyControl />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 通用灵动岛组件 */}
          <Island />

          {/* JSON 选择器（仅逻辑，不渲染） */}
          <JSONSelector />

          {/* JSON 预览 Dialog */}
          <JSONPreviewDialog />
        </div>
      </SidebarProvider>
  );
}

export function ProxyViewer() {
  return (
    <ProxyViewerProvider>
      <ProxyViewerInner />
    </ProxyViewerProvider>
  );
}
