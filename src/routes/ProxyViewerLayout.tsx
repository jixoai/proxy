import { Outlet, Link } from "@tanstack/react-router";
import Logo from "@/logo.svg";
import { Island } from "@/components/Island";
import { JSONSelector } from "@/components/JSONSelector";
import { JSONPreviewDialog } from "@/components/JSONPreviewDialog";
import { ProxyViewerProvider } from "@/components/ProxyViewerContext";
import { PluginUiStreamProvider } from "@/contexts/PluginUiStreamContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
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
import { List, Settings } from "lucide-react";

export function ProxyViewerLayout() {
  return (
    <ErrorBoundary>
      <PluginUiStreamProvider>
        <ProxyViewerProvider>
          <SidebarProvider>
            <div className="bg-background flex h-screen w-full">
              <Sidebar collapsible="icon" className="border-r **:ease-linear">
                <SidebarHeader className="border-b">
                  <div className="flex items-center justify-between transition-all duration-200 group-data-[state=collapsed]:gap-0 group-data-[state=expanded]:gap-2">
                    <div className="flex items-center gap-2 transition-all duration-200 group-data-[state=collapsed]:pointer-events-none group-data-[state=collapsed]:w-0 group-data-[state=collapsed]:-translate-x-8 group-data-[state=collapsed]:opacity-0 group-data-[state=expanded]:opacity-100">
                      <img className="size-8 min-w-8 shrink-0" src={Logo}></img>
                      <span className="font-semibold whitespace-nowrap">Proxy Viewer</span>
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
                          <SidebarMenuButton asChild>
                            <Link to="/" activeProps={{ "data-active": true }}>
                              <List className="h-4 w-4" />
                              <span>请求列表</span>
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                        <SidebarMenuItem>
                          <SidebarMenuButton asChild>
                            <Link to="/control" activeProps={{ "data-active": true }}>
                              <Settings className="h-4 w-4" />
                              <span>内核控制</span>
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>
                </SidebarContent>

                <SidebarFooter className="border-t px-4 py-2">
                  <div className="text-muted-foreground text-xs">Proxy Viewer v1.0</div>
                </SidebarFooter>
              </Sidebar>

              <div className="flex flex-1 flex-col overflow-hidden">
                <div className="flex-1 overflow-hidden">
                  <Outlet />
                </div>
              </div>

              <Island />
              <JSONSelector />
              <JSONPreviewDialog />
            </div>
          </SidebarProvider>
        </ProxyViewerProvider>
      </PluginUiStreamProvider>
    </ErrorBoundary>
  );
}
