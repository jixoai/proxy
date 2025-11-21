// 参考 github.com/tiaanduplessis/kill-port
import { $ } from "bun";
import process from "node:process";
export const killPort = async (
  port: number,
  method = "tcp",
): Promise<boolean> => {
  try {
    port = +port;

    if (!port) {
      throw new Error("Invalid port number provided");
    }

    if (process.platform === "win32") {
      await win32KillPort(port, method);
    } else {
      await unixKillPort(port, method);
    }

    return true;
  } catch (e) {
    console.warn(e instanceof Error ? e.message : String(e));
    return false;
  }
};

const win32KillPort = async (port: number, method: string) => {
  const stdout = (await $`netstat -nao -p ${method}`.text()).trim();

  if (!stdout) {
    return;
  }

  method = method.toUpperCase();
  const lines = stdout.split("\n");

  for (const line of lines) {
    const parts = line.trim().split(/[\s\t]+/);
    if (parts.length < 4) continue;

    const protocol = parts[0];
    const localAddress = parts[1];
    const pid = parts[parts.length - 1];

    if (
      protocol === method &&
      pid !== "0" &&
      localAddress?.endsWith(":" + port)
    ) {
      console.log("端口占用，准备清理\n", line.trim());

      // 确保 PID 是一个有效的数字字符串
      if (pid && !isNaN(Number(pid))) {
        try {
          // 在执行前打印确切的命令
          console.log(`Executing: TaskKill /F /PID ${pid}`);
          await $`TaskKill /F /PID ${pid}`;
          console.log(`成功终止进程 ${pid}`);
        } catch (killError) {
          // 捕获 TaskKill 的特定错误
          console.error(`终止进程 ${pid} 失败。`);
          console.error(`这可能是权限问题。请尝试以管理员身份运行此脚本。`);
          // 打印原始错误信息以便调试
          if (killError instanceof Error) {
            console.error("原始错误:", killError.stack ?? killError.message);
          }
        }
      }
    }
  }
};
const unixKillPort = async (port: number, method: string) => {
  const stdout = (
    await $`lsof -i ${method === "udp" ? "UDP" : "TCP"}:${port}`.text()
  ).trim();
  if (stdout) {
    for (const line of stdout.split("\n")) {
      if (line.includes(method === "udp" ? "UDP" : "LISTEN")) {
        console.log("端口占用，自动清理\n", line);
        const pid = line.split(/\s+/)[1];
        await $`kill ${pid}`;
      }
    }
  }
};

if (import.meta.main) {
  const ports = Bun.argv.slice(2);
  for (const port of ports) {
    await killPort(+port);
  }
}
