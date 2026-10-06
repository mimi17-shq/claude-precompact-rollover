import { readFile } from "node:fs/promises";
import { mergeConfig } from "./core.mjs";

export async function loadConfig(pathname) {
  if (!pathname) return mergeConfig();
  return mergeConfig(JSON.parse(await readFile(pathname, "utf8")));
}
