import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ProxyManager } from "../src/proxy-manager";
import { proxyForwardSchema } from "../src/lib/config-schema";

class TestWorker extends EventTarget {
  terminate = mock(() => {});
  postMessage = mock(() => {
    this.dispatchEvent(new MessageEvent("message", { data: { type: "pong" } }));
  });
}

const managers: ProxyManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager["stopHealthCheck"]();
    manager["cancelRecovery"]();
  }
  mock.restore();
});

function createProbe() {
  const manager = new ProxyManager("heartbeat-test", 0, null);
  managers.push(manager);
  const worker = new TestWorker();
  manager["worker"] = worker as unknown as Worker;
  let tick: () => Promise<void>;
  spyOn(globalThis, "setInterval").mockImplementation(((callback: () => Promise<void>) => {
    tick = callback;
    return 0;
  }) as unknown as typeof setInterval);
  manager["startHealthCheck"]();
  return { manager, worker, tick: () => tick() };
}

function captureRecoveryTimers() {
  const timers: { run: () => Promise<void>; delay: number }[] = [];
  spyOn(globalThis, "setTimeout").mockImplementation(((run: () => Promise<void>, delay: number) => {
    timers.push({ run, delay });
    return timers.length;
  }) as unknown as typeof setTimeout);
  spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
  return timers;
}

describe("proxy worker heartbeat", () => {
  test("preserves configured timeouts and rejects invalid values", () => {
    const forward = { name: "timeout", target: "http://127.0.0.1:12345" };
    for (const timeout of [undefined, null, 0, 0.5, 30]) {
      expect(proxyForwardSchema.parse({ ...forward, timeout }).timeout).toBe(timeout);
    }
    for (const timeout of [-1, Infinity, NaN, "30"]) {
      expect(proxyForwardSchema.safeParse({ ...forward, timeout }).success).toBe(false);
    }
  });
  test("probes a live worker after sleep instead of killing it for an old pong", async () => {
    const { manager, worker, tick } = createProbe();
    const resumedAt = Date.now() + 60_000;
    spyOn(Date, "now").mockReturnValue(resumedAt);

    await tick();

    expect(worker.postMessage).toHaveBeenCalledWith({ type: "ping" });
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(manager.getStatus().running).toBe(true);
  });

  test("installs the pong listener before sending the ping", async () => {
    const { manager, worker, tick } = createProbe();
    await tick();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(manager.getStatus().running).toBe(true);
  });

  test("requires three failed probes and resets the counter on success", async () => {
    const { manager, worker, tick } = createProbe();
    const responses = mock()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({ type: "pong" })
      .mockRejectedValue(new Error("timeout"));
    manager["waitForResponse"] = responses;
    await tick();
    await tick();
    expect(worker.terminate).not.toHaveBeenCalled();
    await tick();
    await tick();
    await tick();
    expect(worker.terminate).not.toHaveBeenCalled();
    await tick();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(manager.getStatus().running).toBe(false);
  });

  test("does not count a timeout whose callback was delayed by sleep", async () => {
    const { manager, worker, tick } = createProbe();
    const clock = spyOn(Date, "now");
    let now = Date.now();
    clock.mockImplementation(() => now);
    manager["waitForResponse"] = mock(async () => {
      now += 60_000;
      throw new Error("timeout after sleep");
    });
    await tick();
    await tick();
    await tick();
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  test("does not overlap probes or let an old probe kill a replacement worker", async () => {
    const { manager, worker, tick } = createProbe();
    let fail!: (error: Error) => void;
    const response = mock(
      () =>
        new Promise<never>((_, reject) => {
          fail = reject;
        }),
    );
    manager["waitForResponse"] = response;
    const pending = tick();
    await tick();
    expect(response).toHaveBeenCalledTimes(1);
    const replacement = new TestWorker();
    manager["worker"] = replacement as unknown as Worker;
    fail(new Error("old worker timeout"));
    await pending;
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(replacement.terminate).not.toHaveBeenCalled();
  });

  test("removes response listeners from the original worker, not its replacement", async () => {
    const { manager, worker } = createProbe();
    const removeOriginal = spyOn(worker, "removeEventListener");
    const replacement = new TestWorker();
    const removeReplacement = spyOn(replacement, "removeEventListener");
    const pending = manager["waitForResponse"]("pong", 5);
    manager["worker"] = replacement as unknown as Worker;
    await expect(pending).rejects.toThrow("Timeout waiting for pong");
    expect(removeOriginal).toHaveBeenCalledTimes(1);
    expect(removeReplacement).not.toHaveBeenCalled();
  });

  test("cleans up a probe when postMessage throws", async () => {
    const { manager, worker } = createProbe();
    const remove = spyOn(worker, "removeEventListener");
    worker.postMessage.mockImplementation(() => {
      throw new Error("Worker terminated");
    });
    await expect(manager["waitForResponse"]("pong", 5000, { type: "ping" })).rejects.toThrow(
      "Worker terminated",
    );
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("proxy worker recovery", () => {
  test("broadcasts a stopped status and schedules only one restart for duplicate events", async () => {
    const { manager, worker } = createProbe();
    const timers = captureRecoveryTimers();
    const states: boolean[] = [];
    manager.onStatusChange(() => states.push(manager.getStatus().running));
    manager["desiredRunning"] = true;
    const restart = mock(async () => {});
    manager["startWorker"] = restart;
    manager["handleWorkerDeath"]();
    manager["handleWorkerDeath"](worker as unknown as Worker);
    expect(states).toEqual([false]);
    expect(timers.map((timer) => timer.delay)).toEqual([1000]);
    await timers[0]!.run();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  test("backs off failed restarts and stops after five attempts", async () => {
    const { manager } = createProbe();
    const timers = captureRecoveryTimers();
    manager["desiredRunning"] = true;
    manager["startWorker"] = mock(async () => {
      throw new Error("startup failed");
    });
    manager["handleWorkerDeath"]();
    for (let attempt = 0; attempt < 5; attempt++) await timers[attempt]!.run();
    expect(timers.map((timer) => timer.delay)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(manager["desiredRunning"]).toBe(false);
    expect(manager.getStatus().running).toBe(false);
  });

  test("explicit stop cancels a pending recovery even when its callback is already queued", async () => {
    const { manager } = createProbe();
    const timers = captureRecoveryTimers();
    manager["desiredRunning"] = true;
    const restart = mock(async () => {});
    manager["startWorker"] = restart;
    manager["handleWorkerDeath"]();
    await manager.stop();
    await timers[0]!.run();
    expect(restart).not.toHaveBeenCalled();
  });

  test("late death events from an old worker cannot terminate the current worker", () => {
    const { manager, worker } = createProbe();
    const replacement = new TestWorker();
    manager["worker"] = replacement as unknown as Worker;
    const statusChanged = mock(() => {});
    manager.onStatusChange(statusChanged);
    manager["handleWorkerDeath"](worker as unknown as Worker);
    expect(replacement.terminate).not.toHaveBeenCalled();
    expect(statusChanged).not.toHaveBeenCalled();
    expect(manager.getStatus().running).toBe(true);
  });

  test("a stale recovery callback cannot erase a newer recovery timer", async () => {
    const { manager } = createProbe();
    const timers = captureRecoveryTimers();
    manager["desiredRunning"] = true;
    manager["handleWorkerDeath"]();
    manager["cancelRecovery"]();
    manager["scheduleRecovery"]();
    const newerTimer = manager["restartTimer"];
    await timers[0]!.run();
    expect(manager["restartTimer"]).toBe(newerTimer);
  });

  test("an old startup rejection cannot clear a manually restarted worker", async () => {
    const { manager } = createProbe();
    manager["worker"] = null;
    let rejectStartup!: (error: Error) => void;
    manager["startWorker"] = mock(
      () =>
        new Promise<never>((_, reject) => {
          rejectStartup = reject;
        }),
    );
    const startup = manager.start();
    await manager.stop();
    const replacement = new TestWorker();
    manager["worker"] = replacement as unknown as Worker;
    manager["desiredRunning"] = true;
    rejectStartup(new Error("previous startup failed"));
    await expect(startup).rejects.toThrow("previous startup failed");
    expect(replacement.terminate).not.toHaveBeenCalled();
    expect(manager["desiredRunning"]).toBe(true);
  });

  test("resets the recovery budget after a stable minute", () => {
    const { manager } = createProbe();
    const timers = captureRecoveryTimers();
    manager["desiredRunning"] = true;
    manager["restartAttempts"] = 5;
    manager["lastRestartTime"] = Date.now() - 61_000;
    manager["handleWorkerDeath"]();
    expect(timers.map((timer) => timer.delay)).toEqual([1000]);
    expect(manager["restartAttempts"]).toBe(1);
  });
});
