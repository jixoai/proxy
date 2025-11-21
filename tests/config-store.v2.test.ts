import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  initConfigStore,
  overrideConfigFilePathForTests,
  getConfigFilePath,
  getAllInstances,
  getInstanceByName,
  upsertInstance,
  deleteInstance,
  getForwardsByInstanceName,
  upsertForward,
  deleteForward,
  reorderForwards,
} from "../src/lib/config-store";
import type { ProxyInstanceConfig, ProxyForwardConfig } from "../src/types/proxy";

const TEST_DIR = path.join(__dirname, "../.tmp/config-store-tests-v2");
const TEST_CONFIG_PATH = path.join(TEST_DIR, "proxy-config.json");

function resetTestConfig() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  overrideConfigFilePathForTests(TEST_CONFIG_PATH);
}

describe("Config Store v2", () => {
  beforeEach(() => {
    resetTestConfig();
    initConfigStore();
  });

  test("should create default config file on first init", () => {
    expect(fs.existsSync(getConfigFilePath())).toBe(true);
    const instances = getAllInstances();
    expect(instances.length).toBeGreaterThan(0);
  });

  test("should upsert instance by name", () => {
    const inst: ProxyInstanceConfig = {
      name: "gateway",
      port: 29000,
      enabled: true,
      description: "GW",
      headers: { Authorization: "Bearer token" },
      forwards: [],
    };
    upsertInstance(inst);
    let saved = getInstanceByName("gateway");
    expect(saved?.port).toBe(29000);

    const updated: ProxyInstanceConfig = { ...inst, port: 29001, enabled: false };
    upsertInstance(updated);
    saved = getInstanceByName("gateway");
    expect(saved?.port).toBe(29001);
    expect(saved?.enabled).toBe(false);
  });

  test("should delete instance and its forwards", () => {
    const inst: ProxyInstanceConfig = {
      name: "temp",
      port: 29100,
      enabled: true,
      description: null,
      headers: null,
      forwards: [
        {
          name: "f1",
          enabled: true,
          target: "https://example.com",
          description: null,
          path: null,
          methods: ["*"],
          headers: null,
        },
      ],
    };
    upsertInstance(inst);
    expect(getInstanceByName("temp")).not.toBeNull();
    deleteInstance("temp");
    expect(getInstanceByName("temp")).toBeNull();
  });

  test("should upsert and reorder forwards", () => {
    const instName = getAllInstances()[0]!.name;
    const fA: ProxyForwardConfig = {
      name: "A",
      enabled: true,
      target: "https://api.example.com/a",
      description: "A",
      path: "/a",
      methods: ["GET"],
      headers: null,
    };
    const fB: ProxyForwardConfig = {
      name: "B",
      enabled: true,
      target: "https://api.example.com/b",
      description: "B",
      path: "/b",
      methods: ["POST"],
      headers: null,
    };

    upsertForward(instName, fA);
    upsertForward(instName, fB);

    const current = getForwardsByInstanceName(instName);
    let forwards = current.filter((f) => f.name === "A" || f.name === "B");
    expect(forwards.map((f) => f.name)).toEqual(["A", "B"]);

    const allNames = current.map((f) => f.name);
    const reordered = allNames.map((name) => {
      if (name === "A") return "B";
      if (name === "B") return "A";
      return name;
    });

    reorderForwards(instName, reordered);
    forwards = getForwardsByInstanceName(instName).filter((f) => f.name === "A" || f.name === "B");
    expect(forwards.map((f) => f.name)).toEqual(["B", "A"]);

    upsertForward(instName, { ...fA, enabled: false });
    const updatedA = getForwardsByInstanceName(instName).find((f) => f.name === "A");
    expect(updatedA?.enabled).toBe(false);

    deleteForward(instName, "B");
    forwards = getForwardsByInstanceName(instName);
    expect(forwards.find((f) => f.name === "B")).toBeUndefined();
  });
});
