import { createConsoleServer } from "./console-server.mjs";
import { isLoopback } from "./console-auth.mjs";

const host = process.env.HOST?.trim() || "127.0.0.1";
const portText = process.env.PORT ?? "8787";
const port = Number(portText);

if (!/^\d+$/.test(portText) || !Number.isSafeInteger(port) || port > 65535) {
  console.error("PORT must be an integer between 0 and 65535.");
  process.exitCode = 1;
} else if (!isLoopback(host) && !process.env.CONSOLE_API_TOKEN?.trim()) {
  console.error(
    "CONSOLE_API_TOKEN is required when listening beyond localhost.",
  );
  process.exitCode = 1;
} else {
  const server = createConsoleServer({
    ...(process.env.HEALING_DATA_DIR?.trim()
      ? { dataDir: process.env.HEALING_DATA_DIR.trim() }
      : {}),
    consoleToken: process.env.CONSOLE_API_TOKEN?.trim() || "",
    workerToken: process.env.HEALING_WORKER_TOKEN?.trim() || "",
    actor: process.env.CONSOLE_OPERATOR_NAME?.trim() || "管理员",
    secureCookies: process.env.CONSOLE_SECURE_COOKIE === "true",
    grafanaToken: process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN?.trim() || "",
    grafanaAllowedOrigins: (process.env.GRAFANA_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
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
      "Persistent management API ready. Agent execution requires an authenticated worker.",
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void server.shutdown().then(
        () => {
          process.exitCode = 0;
        },
        () => {
          console.error("The console could not shut down cleanly.");
          process.exitCode = 1;
        },
      );
    });
  }
}
