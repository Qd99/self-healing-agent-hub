import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(
  new URL("../../apps/console/public/", import.meta.url),
);
const root = resolve(publicDir, "v20");
const relativePath = (base, path) => relative(base, path).split(sep).join("/");

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      forbidden: "Console dependency violates layer boundaries: {{source}}",
    },
  },
  create(context) {
    const importer = resolve(context.filename);
    const own = relativePath(root, importer);
    if (own.startsWith("../")) return {};
    const report = (node, source) =>
      context.report({
        node,
        messageId: "forbidden",
        data: { source: String(source) },
      });
    function inspect(node, value) {
      if (typeof value !== "string" || !value.startsWith("."))
        return report(node, value ?? "dynamic import");
      const target = resolve(dirname(importer), value);
      const to = relativePath(root, target);
      if (to.startsWith("../")) {
        const old = relativePath(publicDir, target);
        const allowed =
          (own === "api/client.js" && old === "api-client.js") ||
          (own === "shared/view.js" && ["model.js", "icons.js"].includes(old));
        if (!allowed) report(node, value);
        return;
      }
      const fromParts = own.split("/");
      const toParts = to.split("/");
      const from = fromParts[0],
        destination = toParts[0];
      const model = /(?:^|[-/])model\.js$/.test(own);
      const controller = /(?:^|[-/])controller\.js$/.test(own);
      const view = /(?:^|[-/])views?\.js$/.test(to);
      let forbidden = false;
      if (from === "shared") forbidden = destination !== "shared";
      if (from === "api") forbidden = !["api"].includes(destination);
      if (from === "session") forbidden = destination !== "session";
      if (from === "domains")
        forbidden =
          !["domains", "shared"].includes(destination) ||
          (destination === "domains" && fromParts[1] !== toParts[1]);
      if (from === "app" && destination === "domains")
        forbidden = toParts.slice(2).join("/") !== "index.js";
      if ((model || controller) && view) forbidden = true;
      if (model && /controller\.js$/.test(to)) forbidden = true;
      if (forbidden) report(node, value);
    }
    return {
      ImportDeclaration: (node) => inspect(node, node.source.value),
      ExportNamedDeclaration: (node) => {
        if (node.source) inspect(node, node.source.value);
      },
      ExportAllDeclaration: (node) => inspect(node, node.source.value),
      ImportExpression: (node) =>
        inspect(
          node,
          node.source.type === "Literal" ? node.source.value : undefined,
        ),
    };
  },
};
