import app from "../index";
import { handle } from "@hono/node-server/vercel";

app.basePath("/api");

export const GET = handle(app);
export const POST = handle(app);
