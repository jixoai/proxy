import { useState, useTransition, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Highlighter } from "@/components/Highlighter";
import { useProxyViewer } from "@/components/ProxyViewerContext";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

function tryFormatJSON(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

export function JSONPreviewDialog() {
  const { jsonDialogOpen, setJsonDialogOpen, dialogJSONSnapshot } =
    useProxyViewer();
  const [activeTab, setActiveTab] = useState("0");
  const [isPending, startTransition] = useTransition();

  // 当对话框关闭时重置 tab
  useEffect(() => {
    if (!jsonDialogOpen) {
      setActiveTab("0");
    }
  }, [jsonDialogOpen]);

  const handleTabChange = (value: string) => {
    startTransition(() => {
      setActiveTab(value);
    });
  };

  return (
    <Dialog open={jsonDialogOpen} onOpenChange={setJsonDialogOpen}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {dialogJSONSnapshot.length === 1
              ? "JSON Preview"
              : `JSON Preview (${dialogJSONSnapshot.length} objects)`}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto">
          {dialogJSONSnapshot.length === 1 ? (
            <Highlighter
              code={tryFormatJSON(dialogJSONSnapshot[0]!)}
              language="json"
              theme="github-dark-default"
              className="rounded-lg"
            />
          ) : dialogJSONSnapshot.length > 1 ? (
            <Tabs
              value={activeTab}
              onValueChange={handleTabChange}
              className="w-full"
            >
              <ScrollArea className="py-2 sticky top-0 z-10 backdrop-blur-xs">
                <TabsList className="inline-flex space-x-1 w-auto min-w-full justify-start">
                  {dialogJSONSnapshot.map((_, index) => (
                    <TabsTrigger
                      key={index}
                      value={String(index)}
                      disabled={isPending}
                    >
                      {index + 1}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
              {dialogJSONSnapshot.map((json, index) => (
                <TabsContent key={index} value={String(index)} className="mt-4">
                  <div className="rounded-lg overflow-hidden">
                    <Highlighter
                      code={tryFormatJSON(json)}
                      language="json"
                      theme="github-dark-default"
                    />
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
