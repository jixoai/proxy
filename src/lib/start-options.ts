export const DEFAULT_VIEWER_PORT = 33000;

export function resolveViewerAddress(
  explicitPort: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  const publicUrl = env.PORTLESS_URL;
  if (!publicUrl) {
    if (env.JIXO_PORTLESS_CHILD === "1") {
      throw new Error("Portless did not provide PORTLESS_URL; HTTPS startup aborted.");
    }
    const port = explicitPort ?? DEFAULT_VIEWER_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error("Web UI port must be an integer between 0 and 65535.");
    }
    return { port, hostname: undefined, publicUrl: undefined };
  }

  const url = new URL(publicUrl);
  if (url.protocol !== "https:") {
    throw new Error("Portless must use HTTPS. Restart it with `portless proxy start --https`.");
  }
  if (url.port) {
    throw new Error(
      `Portless is using HTTPS port ${url.port}. Unset PORTLESS_PORT and restart Portless to use URLs without a port.`,
    );
  }
  if (env.JIXO_PORTLESS_LAN === "1" && !url.hostname.endsWith(".local")) {
    throw new Error(
      "Portless LAN mode is not active. Stop the existing Portless proxy, then restart with --lan.",
    );
  }
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Portless must provide a valid PORT between 1 and 65535.");
  }
  if (explicitPort !== undefined && explicitPort !== port) {
    throw new Error(`Portless assigned port ${port}, but --port requested ${explicitPort}.`);
  }
  return { port, hostname: env.HOST || "127.0.0.1", publicUrl: url.origin };
}
