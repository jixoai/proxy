import type { ReactNode } from "react";

/**
 * BodyViewer 插件系统
 * 参考 Vite 插件系统设计，提供灵活的内容处理和 UI 扩展能力
 */

// ========== 核心类型 ==========

export interface Content {
  mime: string;
  value: Uint8Array;
}

export interface ToolbarAction {
  id: string;
  render: () => ReactNode;
}

export interface TipConfig {
  type: "info" | "warning" | "error" | "success";
  content: ReactNode;
  dismissible?: boolean;
}

// ========== 插件上下文 ==========

/**
 * 插件上下文
 * 提供插件访问 BodyViewer 所有能力的接口
 */
export interface PluginContext {
  // 数据访问
  body: Uint8Array;
  headers: Record<string, string>;
  content: Content;

  // 数据修改
  setContent: (next: Content | ((prev: Content) => Content)) => void;

  // Viewer 管理（静态声明，在 transform 中调用）
  activeViewerId: string | null;
  registerViewer: (registration: ViewerRegistration) => void;

  // 动态交互（在组件内部调用）
  registerActions: (actions: ToolbarAction[]) => () => void;
  showTip: (tip: Omit<TipConfig, "id">, duration?: number) => string;
  hideTip: (id: string) => void;

  // 插件内部状态管理（不是外部配置）
  getConfig: () => any;
  setConfig: (config: any) => void;
}

// ========== 插件钩子 ==========

/**
 * Transform 钩子结果
 * - 返回新的 Content 表示修改内容
 * - 返回 null 表示不修改
 * - 可以是同步或异步
 */
export type TransformResult = Content | null | Promise<Content | null>;

/**
 * Viewer 注册接口
 * 在 transform 中同步声明 tab、content、actions、tips
 * 自动绑定到插件的 name，无需传递 id
 */
export interface ViewerRegistration {
  /**
   * Tab 标签内容
   */
  tab: ReactNode;

  /**
   * Viewer 内容
   */
  content: ReactNode;

  /**
   * 工具栏 actions（可选）
   * 当该 viewer 激活时，这些 actions 会显示在工具栏
   */
  actions?: ToolbarAction[];

  /**
   * 提示信息（可选）
   * 当该 viewer 激活时，这些提示会显示
   */
  tips?: Omit<TipConfig, "id">[];
}

/**
 * 插件状态
 * 每个插件在 transform 执行后的状态
 */
export interface PluginState {
  /**
   * 插件名称
   */
  name: string;

  /**
   * 该插件 transform 后的 content
   */
  content: Content;

  /**
   * 该插件注册的 viewer（可选）
   * 如果插件没有注册 viewer，则为 null
   */
  viewer: ViewerRegistration | null;
}

// ========== 插件接口 ==========

/**
 * BodyViewer 插件接口
 * 参考 Vite 插件设计
 */
export interface BodyViewerPlugin {
  /**
   * 插件名称（唯一标识）
   */
  name: string;

  /**
   * 插件执行顺序
   * - "start": 在核心插件
   * - "pre": 在核心插件之前执行
   * - "core"|undefined|null: 核心插件
   * - "post": 在核心插件之后执行
   * - "end": 在核心插件之后执行
   */
  enforce?: "start" | "pre" | "core" | undefined | null | "post" | "end";

  /**
   * 初始化钩子
   * 在插件首次加载时调用
   */
  onInit?: (ctx: PluginContext) => void | Promise<void>;

  /**
   * 挂载钩子
   * 在插件挂载到 BodyViewer 时调用
   */
  onMount?: (ctx: PluginContext) => void | Promise<void>;

  /**
   * 卸载钩子
   * 在插件从 BodyViewer 卸载时调用，用于清理资源
   */
  onUnmount?: (ctx: PluginContext) => void | Promise<void>;

  /**
   * Transform 钩子
   * 在 content 设置前调用，可以修改内容
   * 多个插件的 transform 会按顺序链式执行
   *
   * 插件可以在 transform 中通过 ctx.registerViewer() 注册 viewer
   * 利用闭包捕获当前阶段的 content
   */
  transform?: (content: Content, ctx: PluginContext) => TransformResult;

  /**
   * Content 变化钩子
   * 在 content 更新后调用（在 transform 之后）
   */
  onContentChange?: (
    content: Content,
    prevContent: Content,
    ctx: PluginContext,
  ) => void | Promise<void>;
}

/**
 * 插件工厂函数类型
 * 允许插件接收配置参数
 */
export type BodyViewerPluginFactory = (options?: any) => BodyViewerPlugin;
