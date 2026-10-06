import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/postgres.ts",
    "src/sqlite.ts",
    "src/mysql.ts",
    "src/cli.ts",
    "src/bin.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
