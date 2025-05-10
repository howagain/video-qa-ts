import "dotenv/config";
import { RPCHandler } from "@orpc/server/fetch";
import { createContext } from "./lib/context";
import { appRouter } from "./routers/index";
import { auth } from "./lib/auth";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { stream } from "hono/streaming";
import { handle } from "@hono/node-server/vercel";

const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: process.env.CORS_ORIGIN || "",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.on(["POST", "GET"], "/api/auth/**", (c) => auth.handler(c.req.raw));

const handler = new RPCHandler(appRouter);
app.use("/rpc/*", async (c, next) => {
  const context = await createContext({ context: c });
  const { matched, response } = await handler.handle(c.req.raw, {
    prefix: "/rpc",
    context: context,
  });
  if (matched) {
    return c.newResponse(response.body, response);
  }
  await next();
});

// Initialize OpenRouter
const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY || "",
  // Optional: Add headers for OpenRouter analytics
  headers: {
    "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "",
    "X-Title": process.env.OPENROUTER_SITE_NAME || "",
  },
});

app.post("/ai", async (c) => {
  try {
    const body = await c.req.json();
    const messages = body.messages || [];
    console.log("Request body for /ai:", body);

    if (!process.env.OPENROUTER_API_KEY) {
      console.error("OPENROUTER_API_KEY is not set.");
      return c.json({ error: "AI provider not configured." }, 500);
    }

    const result = streamText({
      model: openrouter("google/gemini-2.5-flash-preview-04-17"), // Using OpenRouter with a default model
      messages,
    });

    c.header("X-Vercel-AI-Data-Stream", "v1");
    c.header("Content-Type", "text/plain; charset=utf-8");

    return stream(c, async (stream) => {
      try {
        await stream.pipe(result.toDataStream());
      } catch (error) {
        console.error("Error streaming AI response from OpenRouter:", error);
        // stream.write("Error: Could not stream AI response."); // Optionally send an error message in the stream
      }
    });
  } catch (error) {
    console.error("Error in /ai endpoint (OpenRouter):", error);
    return c.json(
      { error: "Failed to process AI request with OpenRouter" },
      500
    );
  }
});

app.get("/", (c) => {
  return c.text("OK");
});

export default handle(app);
