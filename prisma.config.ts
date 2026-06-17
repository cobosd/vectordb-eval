// Env vars are loaded automatically by Bun from .env (no dotenv needed).
import { defineConfig, env } from "prisma/config";

export default defineConfig({
	schema: "prisma/schema.prisma",
	migrations: {
		path: "prisma/migrations",
	},
	engine: "classic",
	datasource: {
		url: env("DB_URL"),
	},
});
