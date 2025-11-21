import type { HighlightRequest, HighlightResponse } from "./highlight.protocol";

type HighlightCallback = (response: HighlightResponse) => void;

/**
 * 共享的 Highlight Worker 服务
 * 单例模式，所有 Highlighter 组件共享同一个 Worker
 */
class HighlightWorkerService {
  private worker: SharedWorker | null = null;
  private port: MessagePort | null = null;
  private requestId = 0;
  private callbacks = new Map<number, HighlightCallback>();
  private initPromise: Promise<void> | null = null;

  private async init() {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise((resolve, reject) => {
      try {
        const url = new URL(
          "/standalone/highlight.shared.worker.ts",
          globalThis.location?.origin ?? undefined,
        );
        this.worker = new SharedWorker(url.href, { type: "module" });
        this.port = this.worker.port;
        this.port.start();
        this.port.onmessage = (event: MessageEvent<HighlightResponse>) => {
          const response = event.data;
          const callback = this.callbacks.get(response.requestId);
          if (callback) {
            callback(response);
            this.callbacks.delete(response.requestId);
          }
        };
        resolve();
      } catch (error) {
        console.error("Failed to create Highlight SharedWorker:", error);
        reject(error);
      }
    });

    return this.initPromise;
  }

  /**
   * 发送高亮请求
   */
  async highlight(
    code: string,
    lang: string,
    theme: string = "github-dark-default",
  ): Promise<HighlightResponse> {
    await this.init();

    return new Promise((resolve, reject) => {
      if (!this.port) {
        reject(new Error("Worker not initialized"));
        return;
      }

      const requestId = this.requestId++;
      const request: HighlightRequest = {
        requestId,
        code,
        lang,
        theme,
      };

      this.callbacks.set(requestId, (response) => {
        resolve(response);
      });

      this.port.postMessage(request);
    });
  }

  /**
   * 清理资源
   */
  destroy() {
    if (this.worker) {
      this.worker.port.close();
      this.worker = null;
      this.port = null;
    }
    this.callbacks.clear();
    this.initPromise = null;
  }
}

// 单例实例
const highlightWorkerService = new HighlightWorkerService();

export default highlightWorkerService;
