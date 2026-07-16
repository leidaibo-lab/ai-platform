#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDemoConfig } from "../src/config/env.mjs";
import { GatewayRequestError, createLiteLlmClient } from "../src/gateway/litellm-client.mjs";
import { RuntimeInputError, createChatRuntime } from "../src/runtime/chat-runtime.mjs";

const rootDir = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const demoDir = join(rootDir, "demo");
const config = await loadDemoConfig(rootDir);
const gatewayClient = createLiteLlmClient(config.gateway);
const chatRuntime = createChatRuntime({
  gatewayClient,
  contextOptions: config.context,
  systemPrompt: config.prompts.demoSystemPrompt,
  summarySystemPrompt: config.prompts.summarySystemPrompt,
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/gateway/status") {
      await sendGatewayStatus(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/runtime/chat") {
      await sendRuntimeChat(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/runtime/summaries") {
      await sendRuntimeSummary(req, res);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "API endpoint not found" });
      return;
    }

    if (req.method === "GET") {
      await sendStatic(url.pathname, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(config.port, () => {
  console.log(`AI Gateway demo: http://localhost:${config.port}`);
  console.log(`Gateway base URL: ${gatewayClient.gatewayBaseUrl}`);
  console.log(`Model alias: ${gatewayClient.model}`);
});

async function sendGatewayStatus(res) {
  sendJson(res, 200, await gatewayClient.status());
}

async function sendRuntimeChat(req, res) {
  try {
    const body = await readJson(req);
    sendJson(res, 200, await chatRuntime.chat(body));
  } catch (error) {
    sendError(res, error);
  }
}

async function sendRuntimeSummary(req, res) {
  try {
    const body = await readJson(req);
    sendJson(res, 200, await chatRuntime.summarize(body));
  } catch (error) {
    sendError(res, error);
  }
}

async function sendStatic(pathname, res) {
  const target = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(demoDir, target));
  if (!filePath.startsWith(demoDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function sendError(res, error) {
  if (error instanceof RuntimeInputError) {
    sendJson(res, error.status, error.payload);
    return;
  }

  if (error instanceof GatewayRequestError) {
    sendJson(res, error.status, {
      error: error.message,
      status: error.status,
    });
    return;
  }

  sendJson(res, 500, { error: error.message || "Unexpected error" });
}

function sendJson(res, statusCode, payload) {
  if (res.headersSent) return;

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 32 * 1024 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}
