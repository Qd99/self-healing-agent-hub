import { createConsoleServer } from "./console-server.mjs";

const host = process.env.HOST?.trim() || "127.0.0.1";
const portText = process.env.PORT ?? "8787";
const port = Number(portText);

if (!/^\d+$/.test(portText) || !Number.isSafeInteger(port) || port > 65535) {
  console.error("PORT must be an integer between 0 and 65535.");
  process.exitCode = 1;
} else {
  const server = createConsoleServer();
  server.on("error", (error) => {
    console.error(
      `The console could not start (${error.code ?? "UNKNOWN_ERROR"}).`,
    );
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const address = server.address();
    const displayHost = address.address.includes(":")
      ? `[${address.address}]`
      : address.address;
    console.log(`Agent console: http://${displayHost}:${address.port}`);
    console.log(
      "Read-only configuration API; no execution engine is connected.",
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      server.close(() => {
        process.exitCode = 0;
      });
      server.closeIdleConnections?.();
    });
  }
}
