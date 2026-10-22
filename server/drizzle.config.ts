import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // `generate` はDBに接続しないためダミー値でよい
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/dummy",
  },
  strict: false,
  verbose: true,
});
