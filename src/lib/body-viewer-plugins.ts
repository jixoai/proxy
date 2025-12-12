import type { BodyViewerPlugin, Content, PluginContext } from "@/contexts/BodyViewerPlugin";

/**
 * 插件系统核心
 * 负责插件的注册、执行和管理
 */

export class PluginManager {
  private plugins: BodyViewerPlugin[] = [];
  private pluginConfigs = new Map<string, any>();
  private initialized = false;
  private mounted = false;

  constructor(plugins: BodyViewerPlugin[] = []) {
    // 插件排序：pre -> 默认(undefined) -> post
    this.plugins = this.sortPlugins(plugins);
  }

  /**
   * 对插件进行过滤排序
   */
  private sortPlugins(plugins: BodyViewerPlugin[]): BodyViewerPlugin[] {
    // 首先删除同名的插件，后来者居上
    plugins = plugins.filter((p, i, self) => self.findLastIndex((p2) => p2.name === p.name) === i);
    // 根据enforce排序
    const corePrePlugins = plugins.filter((p) => p.enforce === "start");
    const prePlugins = plugins.filter((p) => p.enforce === "pre");
    const corePlugins = plugins.filter((p) => null == p.enforce || p.enforce === "core");
    const postPlugins = plugins.filter((p) => p.enforce === "post");
    const corePostPlugins = plugins.filter((p) => p.enforce === "end");
    return [corePrePlugins, prePlugins, corePlugins, postPlugins, corePostPlugins].flat();
  }

  /**
   * 添加插件
   */
  addPlugin(plugin: BodyViewerPlugin): void {
    if (this.plugins.some((p) => p.name === plugin.name)) {
      console.warn(`[PluginManager] Plugin "${plugin.name}" already exists, skipping`);
      return;
    }
    this.plugins = this.sortPlugins([...this.plugins, plugin]);
  }

  /**
   * 移除插件
   */
  removePlugin(name: string): boolean {
    const index = this.plugins.findIndex((p) => p.name === name);
    if (index === -1) return false;
    this.plugins.splice(index, 1);
    this.pluginConfigs.delete(name);
    return true;
  }

  /**
   * 获取所有插件
   */
  getPlugins(): readonly BodyViewerPlugin[] {
    return this.plugins;
  }

  /**
   * 获取插件配置
   */
  getPluginConfig(name: string): any {
    return this.pluginConfigs.get(name);
  }

  /**
   * 设置插件配置
   */
  setPluginConfig(name: string, config: any): void {
    this.pluginConfigs.set(name, config);
  }

  /**
   * 初始化所有插件
   */
  async initialize(ctx: PluginContext): Promise<void> {
    if (this.initialized) return;

    for (const plugin of this.plugins) {
      if (plugin.onInit) {
        try {
          // 为每个插件创建专属上下文，确保 getConfig/setConfig 正常工作
          const pluginCtx = this.createPluginContext(plugin.name, ctx);
          await plugin.onInit(pluginCtx);
        } catch (error) {
          console.error(`[PluginManager] Failed to initialize plugin "${plugin.name}":`, error);
        }
      }
    }

    this.initialized = true;
  }

  /**
   * 挂载所有插件
   */
  async mount(ctx: PluginContext): Promise<void> {
    if (this.mounted) return;

    for (const plugin of this.plugins) {
      if (plugin.onMount) {
        try {
          // 为每个插件创建专属上下文
          const pluginCtx = this.createPluginContext(plugin.name, ctx);
          await plugin.onMount(pluginCtx);
        } catch (error) {
          console.error(`[PluginManager] Failed to mount plugin "${plugin.name}":`, error);
        }
      }
    }

    this.mounted = true;
  }

  /**
   * 卸载所有插件
   */
  async unmount(ctx: PluginContext): Promise<void> {
    if (!this.mounted) return;

    for (const plugin of this.plugins) {
      if (plugin.onUnmount) {
        try {
          // 为每个插件创建专属上下文
          const pluginCtx = this.createPluginContext(plugin.name, ctx);
          await plugin.onUnmount(pluginCtx);
        } catch (error) {
          console.error(`[PluginManager] Failed to unmount plugin "${plugin.name}":`, error);
        }
      }
    }

    this.mounted = false;
  }

  /**
   * 执行 transform 链
   * 按插件顺序依次执行 transform，每个插件的输出作为下一个插件的输入
   */
  async executeTransformChain(initialContent: Content, ctx: PluginContext): Promise<Content> {
    let currentContent = initialContent;

    for (const plugin of this.plugins) {
      if (!plugin.transform) continue;

      try {
        // 为每个插件创建专属上下文（content 通过 transform 参数传入）
        const pluginCtx = this.createPluginContext(plugin.name, ctx);

        const result = await plugin.transform(currentContent, pluginCtx);

        if (result !== null) {
          currentContent = result;
        }
      } catch (error) {
        console.error(`[PluginManager] Plugin "${plugin.name}" transform failed:`, error);
        // 继续执行下一个插件
      }
    }

    return currentContent;
  }

  /**
   * 触发 content 变化事件
   */
  async notifyContentChange(
    content: Content,
    prevContent: Content,
    ctx: PluginContext,
  ): Promise<void> {
    for (const plugin of this.plugins) {
      if (!plugin.onContentChange) continue;

      try {
        // 为每个插件创建专属上下文
        const pluginCtx = this.createPluginContext(plugin.name, ctx);
        await plugin.onContentChange(content, prevContent, pluginCtx);
      } catch (error) {
        console.error(`[PluginManager] Plugin "${plugin.name}" onContentChange failed:`, error);
      }
    }
  }

  /**
   * 创建插件专属的上下文
   * 包装原始上下文，添加插件配置 API
   */
  private createPluginContext(pluginName: string, baseCtx: PluginContext): PluginContext {
    return {
      ...baseCtx,
      getConfig: () => this.getPluginConfig(pluginName),
      setConfig: (config: any) => this.setPluginConfig(pluginName, config),
    };
  }
}

/**
 * 创建插件管理器实例
 */
export function createPluginManager(plugins: BodyViewerPlugin[] = []): PluginManager {
  return new PluginManager(plugins);
}
