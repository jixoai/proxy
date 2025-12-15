import { Component, type ReactNode, type ErrorInfo } from "react";
import { ErrorDialog } from "./ErrorDialog";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  dialogOpen: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      dialogOpen: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
      dialogOpen: true,
    };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    this.setState({
      error,
      errorInfo,
    });
  }

  handleDialogOpenChange = (open: boolean): void => {
    this.setState({ dialogOpen: open });
  };

  handleRetry = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      dialogOpen: false,
    });
  };

  override render(): ReactNode {
    const { hasError, error, errorInfo, dialogOpen } = this.state;
    const { children, fallback } = this.props;

    if (hasError && fallback) {
      return (
        <>
          {fallback}
          <ErrorDialog
            open={dialogOpen}
            onOpenChange={this.handleDialogOpenChange}
            error={error}
            errorInfo={errorInfo}
            onRetry={this.handleRetry}
          />
        </>
      );
    }

    if (hasError) {
      return (
        <ErrorDialog
          open={dialogOpen}
          onOpenChange={this.handleDialogOpenChange}
          error={error}
          errorInfo={errorInfo}
          onRetry={this.handleRetry}
        />
      );
    }

    return children;
  }
}
