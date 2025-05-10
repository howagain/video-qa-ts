import { handle } from "hono/vercel";
import app from "@/index";

export const GET = handle(app);
export const POST = handle(app);
