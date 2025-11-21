const server = Bun.serve({
  port: 10002,
  fetch(req) {
    if (new URL(req.url).pathname === "/sse") {
      return new Response(
        new ReadableStream({
          async start(controller) {
            for (let i = 0; i < 10; i++) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
              controller.enqueue(`data: Hello World ${i}\n\n`);
            }
            controller.close();
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        },
      );
    }
    return new Response(req.url, {
      headers: {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  },
});
console.log(server.url.href);
