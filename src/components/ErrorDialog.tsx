import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertCircle, Copy, Check, RefreshCw } from "lucide-react";

interface ErrorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  error: Error | null;
  errorInfo?: React.ErrorInfo | null;
  onRetry?: () => void;
}

export function ErrorDialog({
  open,
  onOpenChange,
  error,
  errorInfo,
  onRetry,
}: ErrorDialogProps) {
  const [copied, setCopied] = useState(false);

  const getErrorText = useCallback(() => {
    if (!error) return "";

    const parts: string[] = [
      `Error: ${error.name}`,
      `Message: ${error.message}`,
    ];

    if (error.stack) {
      parts.push("", "Stack Trace:", error.stack);
    }

    if (errorInfo?.componentStack) {
      parts.push("", "Component Stack:", errorInfo.componentStack);
    }

    return parts.join("\n");
  }, [error, errorInfo]);

  const handleCopy = useCallback(async () => {
    const text = getErrorText();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy error:", err);
    }
  }, [getErrorText]);

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleRetry = useCallback(() => {
    onOpenChange(false);
    onRetry?.();
  }, [onOpenChange, onRetry]);

  if (!error) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-5 w-5" />
            <span>An Error Occurred</span>
          </DialogTitle>
          <DialogDescription>
            An unexpected error has occurred. You can copy the error details below to report the issue.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive">{error.name}</p>
            <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
          </div>

          <div className="relative">
            <div className="absolute right-2 top-2 z-10">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopy}
                className="h-8 gap-1.5 text-xs"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </>
                )}
              </Button>
            </div>
            <ScrollArea className="h-64 rounded-md border bg-muted/30">
              <pre className="p-4 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-all">
                {error.stack && (
                  <div>
                    <span className="font-semibold text-foreground">Stack Trace:</span>
                    {"\n"}
                    {error.stack}
                  </div>
                )}
                {errorInfo?.componentStack && (
                  <div className="mt-4">
                    <span className="font-semibold text-foreground">Component Stack:</span>
                    {"\n"}
                    {errorInfo.componentStack}
                  </div>
                )}
              </pre>
            </ScrollArea>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {onRetry && (
            <Button variant="outline" onClick={handleRetry}>
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          )}
          <Button variant="default" onClick={handleClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
