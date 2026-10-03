import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";
import { RouteConflictError, RouteStore } from "portless";
import { getInstanceHostname, PortlessInstanceRoutes } from "../src/lib/portless";
import { resolveViewerAddress } from "../src/lib/start-options";

describe("viewer startup modes", () => {
  test("keeps the existing localhost default and ignores unrelated PORT/HOST", () => {
    expect(resolveViewerAddress(undefined, { PORT: "1234", HOST: "example.com" })).toEqual({
      port: 33000,
      hostname: undefined,
      publicUrl: undefined,
    });
  });

  test("honors explicit local ports, including a random port", () => {
    expect(resolveViewerAddress(33001, {}).port).toBe(33001);
    expect(resolveViewerAddress(0, {}).port).toBe(0);
  });

  test("rejects invalid local ports", () => {
    for (const port of [-1, 65536, 1.5, NaN]) {
      expect(() => resolveViewerAddress(port, {})).toThrow("Web UI port");
    }
  });

  test("uses the injected port, host, and public HTTPS URL", () => {
    expect(
      resolveViewerAddress(undefined, {
        PORTLESS_URL: "https://proxy.localhost/",
        PORT: "4567",
        HOST: "127.0.0.1",
      }),
    ).toEqual({ port: 4567, hostname: "127.0.0.1", publicUrl: "https://proxy.localhost" });
  });

  test("requires Portless LAN mode to provide a .local address", () => {
    expect(() =>
      resolveViewerAddress(undefined, {
        PORTLESS_URL: "https://proxy.localhost",
        PORT: "4567",
        JIXO_PORTLESS_LAN: "1",
      }),
    ).toThrow("Portless LAN mode is not active");
    expect(
      resolveViewerAddress(undefined, {
        PORTLESS_URL: "https://proxy.local",
        PORT: "4567",
        JIXO_PORTLESS_LAN: "1",
      }).publicUrl,
    ).toBe("https://proxy.local");
  });

  test("does not silently override the registered upstream port", () => {
    expect(() =>
      resolveViewerAddress(33000, {
        PORTLESS_URL: "https://proxy.localhost",
        PORT: "4567",
      }),
    ).toThrow("Portless assigned port 4567");
  });

  test("requires a valid assigned port in HTTPS mode", () => {
    for (const port of [undefined, "", "0", "65536", "1.5", "4000abc"]) {
      expect(() =>
        resolveViewerAddress(undefined, {
          PORTLESS_URL: "https://proxy.localhost",
          PORT: port,
        }),
      ).toThrow("Portless must provide a valid PORT");
    }
  });

  test("refuses an HTTP URL instead of claiming HTTPS is enabled", () => {
    expect(() =>
      resolveViewerAddress(undefined, {
        PORTLESS_URL: "http://proxy.localhost",
        PORT: "4567",
      }),
    ).toThrow("Portless must use HTTPS");
  });

  test("requires Portless HTTPS to use the standard port for clean URLs", () => {
    expect(() =>
      resolveViewerAddress(undefined, {
        PORTLESS_URL: "https://proxy.localhost:8443",
        PORT: "4567",
      }),
    ).toThrow("Unset PORTLESS_PORT");
  });

  test("does not recursively relaunch when Portless fails to inject its environment", () => {
    expect(() => resolveViewerAddress(undefined, { JIXO_PORTLESS_CHILD: "1" })).toThrow(
      "Portless did not provide PORTLESS_URL",
    );
  });
});

describe("instance HTTPS hostnames", () => {
  test("derives readable hostnames from JSON instance names", () => {
    expect(getInstanceHostname("llm-lab", "proxy.localhost")).toBe("llm-lab.proxy.localhost");
    expect(getInstanceHostname("llm-lab", "proxy.local")).toBe("llm-lab.proxy.local");
    expect(getInstanceHostname("20002", "proxy.localhost")).toBe("20002.proxy.localhost");
  });

  test("normalizes names deterministically without slug collisions", () => {
    const names = ["a-b", "a b", "A-B", "中文", "测试", "a".repeat(80)];
    const hostnames = names.map((name) => getInstanceHostname(name, "proxy.localhost"));
    expect(new Set(hostnames).size).toBe(names.length);
    for (const [index, name] of names.entries()) {
      const hostname = hostnames[index]!;
      expect(getInstanceHostname(name, "proxy.localhost")).toBe(hostname);
      expect(hostname.split(".")[0]!.length).toBeLessThanOrEqual(63);
      expect(hostname).toMatch(/^[a-z0-9][a-z0-9-]*\.proxy\.localhost$/);
    }
  });
});

describe("Portless instance route lifecycle", () => {
  const tempDirectories: string[] = [];
  const createStore = () => {
    const directory = mkdtempSync(path.join(import.meta.dirname, ".portless-"));
    tempDirectories.push(directory);
    return new RouteStore(directory);
  };

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("registers running instances, updates ports, and removes stopped instances", () => {
    const store = createStore();
    const routes = new PortlessInstanceRoutes("https://proxy.localhost", store);
    expect(routes.update("llm-lab", { running: true, port: 20002 })).toBe(
      "https://llm-lab.proxy.localhost",
    );
    expect(store.loadRoutes()).toEqual([
      { hostname: "llm-lab.proxy.localhost", port: 20002, pid: process.pid },
    ]);
    routes.update("llm-lab", { running: true, port: 20003 });
    expect(store.loadRoutes()[0]!.port).toBe(20003);
    routes.update("llm-lab", { running: false, port: 20003 });
    expect(store.loadRoutes()).toEqual([]);
  });

  test("preserves the configured HTTPS proxy port in instance URLs", () => {
    const store = createStore();
    const routes = new PortlessInstanceRoutes("https://proxy.localhost:9443", store);
    expect(routes.update("api", { running: true, port: 20002 })).toBe(
      "https://api.proxy.localhost:9443",
    );
    routes.close();
  });

  test("cleans up only project-owned routes and supports repeated shutdown", () => {
    const store = createStore();
    store.addRoute("other.localhost", 20001, 0);
    const routes = new PortlessInstanceRoutes("https://proxy.localhost", store);
    routes.update("api", { running: true, port: 20002 });
    routes.close();
    routes.close();
    expect(store.loadRoutes()).toEqual([{ hostname: "other.localhost", port: 20001, pid: 0 }]);
  });

  test("does not replace or delete a conflicting application's route", () => {
    const store = createStore();
    store.addRoute("api.proxy.localhost", 20001, 0);
    const routes = new PortlessInstanceRoutes("https://proxy.localhost", store);
    expect(() => routes.update("api", { running: true, port: 20002 })).toThrow(RouteConflictError);
    routes.close();
    expect(store.loadRoutes()).toEqual([{ hostname: "api.proxy.localhost", port: 20001, pid: 0 }]);
  });

  test("does not remove a route that has been taken over by another owner", () => {
    const store = createStore();
    const routes = new PortlessInstanceRoutes("https://proxy.localhost", store);
    routes.update("api", { running: true, port: 20002 });
    store.removeRoute("api.proxy.localhost", process.pid);
    store.addRoute("api.proxy.localhost", 20003, 0);
    routes.close();
    expect(store.loadRoutes()).toEqual([{ hostname: "api.proxy.localhost", port: 20003, pid: 0 }]);
  });
});
