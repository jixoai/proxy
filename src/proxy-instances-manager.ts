import { ProxyManager, type ProxyStatus, type ProxyLogMessage, type ForwardConfig } from "./lib/proxy-manager";
import { getAllInstances, getForwardsByInstanceName } from "./lib/config-store";
import { killPort } from "./lib/kill-port";

type LogCallback = (log: ProxyLogMessage) => void;

export class ProxyInstancesManager {
  private managers = new Map<string, ProxyManager>();
  private logCallbacks = new Set<LogCallback>();

  async startInstance(instanceName: string): Promise<void> {
    const instance = getAllInstances().find((i) => i.name === instanceName);
    if (!instance) throw new Error("Instance not found");
    if (this.managers.has(instanceName)) throw new Error("Instance already running");

    console.log(`[ProxyInstancesManager] Cleaning port ${instance.port} before starting...`);
    await killPort(instance.port);

    const forwards = getForwardsByInstanceName(instanceName);
    const validForwards: ForwardConfig[] = forwards.map((f) => ({
      name: f.name,
      target: f.target,
      enabled: f.enabled,
      description: f.description ?? null,
      path: f.path ?? null,
      methods: f.methods && f.methods.length ? f.methods : ["*"],
      headers: f.headers ?? null,
    }));

    const manager = new ProxyManager(instanceName, instance.port, instance.headers ?? null);
    manager.onLog((log) => {
      this.logCallbacks.forEach((cb) => {
        try {
          cb(log);
        } catch (error) {
          console.error("[ProxyInstancesManager] Error in log callback:", error);
        }
      });
    });

    try {
      await manager.start(validForwards);
      this.managers.set(instanceName, manager);
      console.log(
        `[ProxyInstancesManager] Instance ${instance.name} started successfully on port ${instance.port}`,
      );
    } catch (error) {
      console.error(`[ProxyInstancesManager] Failed to start instance ${instance.name}:`, error);
      throw error;
    }
  }

  async stopInstance(instanceName: string): Promise<void> {
    const manager = this.managers.get(instanceName);
    if (!manager) throw new Error("Instance not running");
    await manager.stop();
    this.managers.delete(instanceName);
    console.log(`[ProxyInstancesManager] Instance ${instanceName} stopped successfully`);
  }

  async reloadInstance(instanceName: string): Promise<void> {
    const instance = getAllInstances().find((i) => i.name === instanceName);
    if (!instance) {
      throw new Error("Instance not found");
    }
    const forwards = getForwardsByInstanceName(instanceName);
    const validForwards: ForwardConfig[] = forwards.map((f) => ({
      name: f.name,
      target: f.target,
      enabled: f.enabled,
      description: f.description ?? null,
      path: f.path ?? null,
      methods: f.methods && f.methods.length ? f.methods : ["*"],
      headers: f.headers ?? null,
    }));

    const manager = this.managers.get(instanceName);
    if (!manager) {
      await this.startInstance(instanceName);
      return;
    }

    await manager.reload(validForwards);
  }

  getInstanceStatus(instanceName: string): ProxyStatus {
    const manager = this.managers.get(instanceName);
    if (!manager) {
      const instance = getAllInstances().find((i) => i.name === instanceName);
      return { running: false, port: instance?.port ?? 0 };
    }
    return manager.getStatus();
  }

  getAllStatuses(): Map<string, ProxyStatus> {
    const statuses = new Map<string, ProxyStatus>();
    const instances = getAllInstances();
    for (const instance of instances) {
      statuses.set(instance.name, this.getInstanceStatus(instance.name));
    }
    return statuses;
  }

  getRunningInstanceNames(): string[] {
    return Array.from(this.managers.keys());
  }

  onLog(callback: LogCallback): () => void {
    this.logCallbacks.add(callback);
    return () => this.logCallbacks.delete(callback);
  }

  async autoStartEnabledInstances(): Promise<void> {
    const enabledInstances = getAllInstances().filter((inst) => inst.enabled);
    if (enabledInstances.length === 0) {
      console.log("[ProxyInstancesManager] No enabled instances to auto-start");
      return;
    }
    console.log(`\n[ProxyInstancesManager] Auto-starting ${enabledInstances.length} enabled instance(s)...`);
    for (const instance of enabledInstances) {
      try {
        await this.startInstance(instance.name);
        console.log(`[ProxyInstancesManager] Instance ${instance.name} (port ${instance.port}) started`);
      } catch (error) {
        console.error(`[ProxyInstancesManager] Instance ${instance.name} failed to start:`, error);
      }
    }
    console.log(`\n[ProxyInstancesManager] Auto-start completed\n`);
  }

  async stopAll(): Promise<void> {
    console.log(`\n[ProxyInstancesManager] Stopping all ${this.managers.size} running instance(s)...`);
    const stopPromises = Array.from(this.managers.keys()).map(async (name) => {
      try {
        await this.stopInstance(name);
      } catch (error) {
        console.error(`[ProxyInstancesManager] Failed to stop instance ${name}:`, error);
      }
    });
    await Promise.all(stopPromises);
    console.log("[ProxyInstancesManager] All instances stopped\n");
  }
}
