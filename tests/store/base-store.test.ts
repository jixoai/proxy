import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { BaseStore, type StoreChangeEvent, type StoreOptions } from "../../src/lib/store/base-store";

const TEST_DIR = path.join(__dirname, "../../.tmp/base-store-tests");
const TEST_FILE_PATH = path.join(TEST_DIR, "test-store.json");

interface TestData {
  name: string;
  value: number;
  items: string[];
}

class TestStore extends BaseStore<TestData> {
  constructor(initialData: TestData, filePath: string | null = null, options: StoreOptions = {}) {
    super(initialData, filePath, options);
  }

  // Expose protected method for testing
  public updateData(newData: TestData): void {
    this.setData(newData);
  }

  protected parseFileContent(content: string): TestData {
    return JSON.parse(content);
  }

  protected serializeData(data: TestData): string {
    return JSON.stringify(data, null, 2);
  }

  protected cloneData(data: TestData): TestData {
    return JSON.parse(JSON.stringify(data));
  }

  protected isDataEqual(a: TestData, b: TestData): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }
}

function cleanupTestDir() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function createTestData(name: string = "test", value: number = 42): TestData {
  return { name, value, items: ["a", "b", "c"] };
}

describe("BaseStore", () => {
  let store: TestStore;

  beforeEach(() => {
    cleanupTestDir();
  });

  afterEach(() => {
    if (store && !store.isDestroyed()) {
      store.destroy();
    }
  });

  describe("basic operations", () => {
    test("should initialize with data", () => {
      const data = createTestData();
      store = new TestStore(data);

      expect(store.getData()).toEqual(data);
      expect(store.getVersion()).toBe(0);
    });

    test("should return cloned data", () => {
      store = new TestStore(createTestData());

      const data1 = store.getData();
      const data2 = store.getData();

      expect(data1).not.toBe(data2);
      expect(data1).toEqual(data2);
    });

    test("should increment version on update", () => {
      store = new TestStore(createTestData());
      expect(store.getVersion()).toBe(0);

      store.updateData(createTestData("updated", 100));
      expect(store.getVersion()).toBe(1);

      store.updateData(createTestData("updated2", 200));
      expect(store.getVersion()).toBe(2);
    });

    test("should emit change event on update", () => {
      store = new TestStore(createTestData());

      const events: StoreChangeEvent<TestData>[] = [];
      store.on("change", (event) => events.push(event));

      store.updateData(createTestData("updated", 100));

      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("update");
      expect(events[0]!.data.name).toBe("updated");
      expect(events[0]!.previousData!.name).toBe("test");
    });

    test("should emit specific event type", () => {
      store = new TestStore(createTestData());

      const updateEvents: StoreChangeEvent<TestData>[] = [];
      store.on("update", (event) => updateEvents.push(event));

      store.updateData(createTestData("updated"));

      expect(updateEvents.length).toBe(1);
    });
  });

  describe("file operations", () => {
    test("should load from file", async () => {
      const data = createTestData("from-file", 999);
      fs.writeFileSync(TEST_FILE_PATH, JSON.stringify(data));

      store = new TestStore(createTestData(), TEST_FILE_PATH);
      const loaded = await store.loadFromFile();

      expect(loaded).toEqual(data);
    });

    test("should save to file", async () => {
      const data = createTestData("save-test", 123);
      store = new TestStore(data, TEST_FILE_PATH);

      await store.saveToFile();

      const content = fs.readFileSync(TEST_FILE_PATH, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed).toEqual(data);
    });

    test("should throw when loading without file path", async () => {
      store = new TestStore(createTestData());

      await expect(store.loadFromFile()).rejects.toThrow("no associated file path");
    });

    test("should throw when saving without file path", async () => {
      store = new TestStore(createTestData());

      await expect(store.saveToFile()).rejects.toThrow("no associated file path");
    });

    test("should reload and update store", async () => {
      const initialData = createTestData("initial");
      fs.writeFileSync(TEST_FILE_PATH, JSON.stringify(initialData));

      store = new TestStore(initialData, TEST_FILE_PATH);

      // Modify file externally
      const updatedData = createTestData("external-update", 555);
      fs.writeFileSync(TEST_FILE_PATH, JSON.stringify(updatedData));

      await store.reload();

      expect(store.getData()).toEqual(updatedData);
    });

    test("should emit reload event on reload", async () => {
      const initialData = createTestData();
      fs.writeFileSync(TEST_FILE_PATH, JSON.stringify(initialData));

      store = new TestStore(initialData, TEST_FILE_PATH);

      const events: StoreChangeEvent<TestData>[] = [];
      store.on("reload", (event) => events.push(event));

      const updatedData = createTestData("reloaded");
      fs.writeFileSync(TEST_FILE_PATH, JSON.stringify(updatedData));
      await store.reload();

      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("reload");
    });

    test("should not emit event if data unchanged on reload", async () => {
      const data = createTestData();
      fs.writeFileSync(TEST_FILE_PATH, JSON.stringify(data));

      store = new TestStore(data, TEST_FILE_PATH);

      const events: StoreChangeEvent<TestData>[] = [];
      store.on("change", (event) => events.push(event));

      await store.reload();

      expect(events.length).toBe(0);
    });
  });

  describe("file watching", () => {
    test("should start watching when enabled", async () => {
      const data = createTestData();
      fs.writeFileSync(TEST_FILE_PATH, JSON.stringify(data));

      store = new TestStore(data, TEST_FILE_PATH, { enableWatch: true });

      // Modify file
      const updatedData = createTestData("watched-update");
      fs.writeFileSync(TEST_FILE_PATH, JSON.stringify(updatedData));

      // Wait for debounce + file system event
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(store.getData().name).toBe("watched-update");
    });

    test("should stop watching on stopWatch", async () => {
      const data = createTestData();
      fs.writeFileSync(TEST_FILE_PATH, JSON.stringify(data));

      store = new TestStore(data, TEST_FILE_PATH, { enableWatch: true });
      store.stopWatch();

      // Modify file
      const updatedData = createTestData("after-stop");
      fs.writeFileSync(TEST_FILE_PATH, JSON.stringify(updatedData));

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should still have original data
      expect(store.getData().name).toBe("test");
    });

    test("should debounce rapid file changes", async () => {
      const data = createTestData();
      fs.writeFileSync(TEST_FILE_PATH, JSON.stringify(data));

      store = new TestStore(data, TEST_FILE_PATH, {
        enableWatch: true,
        watchDebounceMs: 100,
      });

      const events: StoreChangeEvent<TestData>[] = [];
      store.on("change", (event) => events.push(event));

      // Rapid changes
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(TEST_FILE_PATH, JSON.stringify(createTestData(`change-${i}`, i)));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should only have 1-2 events due to debouncing
      expect(events.length).toBeLessThanOrEqual(2);
    });
  });

  describe("destroy", () => {
    test("should mark as destroyed", () => {
      store = new TestStore(createTestData());
      expect(store.isDestroyed()).toBe(false);

      store.destroy();
      expect(store.isDestroyed()).toBe(true);
    });

    test("should stop watching on destroy", async () => {
      const data = createTestData();
      fs.writeFileSync(TEST_FILE_PATH, JSON.stringify(data));

      store = new TestStore(data, TEST_FILE_PATH, { enableWatch: true });
      store.destroy();

      // Modify file
      fs.writeFileSync(TEST_FILE_PATH, JSON.stringify(createTestData("after-destroy")));
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Data should remain unchanged (watcher stopped)
      expect(store.getData().name).toBe("test");
    });

    test("should remove all listeners on destroy", () => {
      store = new TestStore(createTestData());

      let called = false;
      store.on("change", () => {
        called = true;
      });

      store.destroy();
      store.updateData(createTestData("no-emit"));

      expect(called).toBe(false);
    });

    test("should ignore updates after destroy", () => {
      store = new TestStore(createTestData("original"));
      store.destroy();

      store.updateData(createTestData("ignored"));

      // Version should not change
      expect(store.getVersion()).toBe(0);
    });
  });

  describe("error handling", () => {
    test("should emit error on reload failure", async () => {
      store = new TestStore(createTestData(), TEST_FILE_PATH);

      const errors: Error[] = [];
      store.on("error", (error) => errors.push(error));

      // File doesn't exist
      await store.reload();

      expect(errors.length).toBe(1);
    });

    test("should emit watch-error on watch failure", () => {
      store = new TestStore(createTestData(), "/nonexistent/path/file.json");

      const errors: Error[] = [];
      store.on("watch-error", (error) => errors.push(error));

      store.startWatch();

      expect(errors.length).toBe(1);
    });
  });
});
