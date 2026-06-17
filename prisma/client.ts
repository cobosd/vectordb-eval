import { PrismaClient } from "@prisma/client";

// Shared Prisma client. Bun loads .env (DB_URL) automatically.
export const prisma = new PrismaClient();
