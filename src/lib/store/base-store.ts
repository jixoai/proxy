import { EventEmitter } from "node:events";
import * as fs from "node:fs";

export type StoreChangeType = "create" | "update" | "delete" | "reload";

export interface StoreChangeEvent<T> {
  type: StoreChangeType;
  data: T;
  previousData?: T;
  timestamp: number;
}

export interface StoreOptions {
  /** 是否启用文件监听 */
  enableWatch?: boolean;
  /** 文件变更防抖延迟（毫秒） */
  watchDebounceMs?: number;
}

const DEFAULT_WATCH_DEBOUNCE_MS = 100;

/**
 * Store 基类
 * 提供事件发射、文件监听、状态管理的基础能力
 */
export abstract class BaseStore<T> extends EventEmitter {
  protected data: T;
  protected readonly filePath: string | null;
  protected watcher: fs.FSWatcher | null = null;
  protected watchDebounceTimer: NodeJS.Timeout | null = null;
  protected readonly watchDebounceMs: number;
  protected version: number = 0;
  protected lastLoadTime: number = 0;
  private destroyed: boolean = false;

  constructor(initialData: T, filePath: string | null = null, options: StoreOptions = {}) {
    super();
    this.data = initialData;
    this.filePath = filePath;
    this.watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;

    if (filePath && options.enableWatch) {
      this.startWatch();
    }
  }

  /** 获取当前数据（只读副本） */
  getData(): T {
    return this.cloneData(this.data);
  }

  /** 获取当前版本号 */
  getVersion(): number {
    return this.version;
  }

  /** 是否已销毁 */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  /** 更新数据并触发事件 */
  protected setData(newData: T, changeType: StoreChangeType = "update"): void {
    if (this.destroyed) return;

    const previousData = this.cloneData(this.data);
    this.data = newData;
    this.version++;

    const event: StoreChangeEvent<T> = {
      type: changeType,
      data: this.cloneData(newData),
      previousData,
      timestamp: Date.now(),
    };

    this.emit("change", event);
    this.emit(changeType, event);
  }

  /** 从文件加载数据（同步） */
  loadFromFileSync(): T {
    if (!this.filePath) {
      throw new Error("Store has no associated file path");
    }

    const content = fs.readFileSync(this.filePath, "utf-8");
    const parsed = this.parseFileContent(content);
    this.lastLoadTime = Date.now();
    return parsed;
  }

  /** 从文件加载数据（异步） */
  async loadFromFile(): Promise<T> {
    if (!this.filePath) {
      throw new Error("Store has no associated file path");
    }

    const content = await fs.promises.readFile(this.filePath, "utf-8");
    const parsed = this.parseFileContent(content);
    this.lastLoadTime = Date.now();
    return parsed;
  }

  /** 保存数据到文件（同步） */
  saveToFileSync(): void {
    if (!this.filePath) {
      throw new Error("Store has no associated file path");
    }

    const content = this.serializeData(this.data);
    fs.writeFileSync(this.filePath, content, "utf-8");
  }

  /** 保存数据到文件（异步） */
  async saveToFile(): Promise<void> {
    if (!this.filePath) {
      throw new Error("Store has no associated file path");
    }

    const content = this.serializeData(this.data);
    await fs.promises.writeFile(this.filePath, content, "utf-8");
  }

  /** 重新加载文件并更新 Store */
  async reload(): Promise<void> {
    if (!this.filePath) return;

    try {
      const newData = await this.loadFromFile();
      if (!this.isDataEqual(this.data, newData)) {
        this.setData(newData, "reload");
      }
    } catch (error) {
      this.emit("error", error);
    }
  }

  /** 启动文件监听 */
  startWatch(): void {
    if (!this.filePath || this.watcher) return;

    try {
      this.watcher = fs.watch(this.filePath, (eventType) => {
        if (eventType === "change") {
          this.handleFileChange();
        }
      });

      this.watcher.on("error", (error) => {
        this.emit("watch-error", error);
      });
    } catch (error) {
      this.emit("watch-error", error);
    }
  }

  /** 检查是否正在监听文件 */
  isWatching(): boolean {
    return this.watcher !== null;
  }

  /** 停止文件监听 */
  stopWatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }
  }

  /** 销毁 Store */
  destroy(): void {
    this.destroyed = true;
    this.stopWatch();
    this.removeAllListeners();
  }

  /** 处理文件变更（带防抖） */
  private handleFileChange(): void {
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
    }

    this.watchDebounceTimer = setTimeout(() => {
      this.watchDebounceTimer = null;
      this.reload().catch((error) => {
        this.emit("error", error);
      });
    }, this.watchDebounceMs);
  }

  /** 解析文件内容为数据对象 */
  protected abstract parseFileContent(content: string): T;

  /** 序列化数据为文件内容 */
  protected abstract serializeData(data: T): string;

  /** 深拷贝数据 */
  protected abstract cloneData(data: T): T;

  /** 比较两个数据是否相等 */
  protected abstract isDataEqual(a: T, b: T): boolean;
}
