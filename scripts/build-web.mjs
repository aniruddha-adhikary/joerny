import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("public", { recursive: true });

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/web/main.ts"],
  bundle: true,
  outfile: "public/bundle.js",
  format: "iife",
  target: ["es2020"],
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
};

if (watch) {
  const { context } = await import("esbuild");
  const ctx = await context(options);
  await ctx.watch();
  console.log("[joerny] watching web sources...");
} else {
  await build(options);
}
