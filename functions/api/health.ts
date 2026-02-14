import { json } from "../_lib/http";
import type { Env } from "../_lib/types";

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  return json({
    ok: true,
    version: env.APP_VERSION ?? "0.1.0",
    service: "story-library",
    timestamp: new Date().toISOString(),
  });
};
