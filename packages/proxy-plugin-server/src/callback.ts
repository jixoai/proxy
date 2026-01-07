/**
 * __CALLBACK_URL__ 回报逻辑
 */

export async function reportReady(url: string): Promise<void> {
  const callbackUrl = process.env.__CALLBACK_URL__;
  if (!callbackUrl) {
    console.log(`[proxy-plugin-server] No __CALLBACK_URL__, running standalone mode`);
    console.log(`[proxy-plugin-server] Proxy server listening on ${url}`);
    return;
  }

  try {
    const response = await fetch(callbackUrl, {
      method: "POST",
      body: url,
      headers: { "Content-Type": "text/plain" },
    });
    if (!response.ok) {
      throw new Error(`Callback failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error(`[proxy-plugin-server] Failed to report ready to ${callbackUrl}:`, error);
    throw error;
  }
}
