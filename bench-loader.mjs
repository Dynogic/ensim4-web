import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".json")) {
    const r = await next(specifier, context);
    return { ...r, importAttributes: { type: "json" } };
  }
  if (specifier.startsWith(".") && !specifier.endsWith(".ts") && !specifier.endsWith(".mjs")) {
    try {
      const u = new URL(specifier + ".ts", context.parentURL);
      if (existsSync(fileURLToPath(u))) return next(specifier + ".ts", context);
    } catch {}
  }
  return next(specifier, context);
}
