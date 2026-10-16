import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

export type CreatePrismaOptions = {
  connectionString: string;
  /** Máximo de conexiones del pool (por proceso). */
  max?: number;
};

export function createPrisma({ connectionString, max = 10 }: CreatePrismaOptions) {
  const adapter = new PrismaPg({ connectionString, max });
  return new PrismaClient({ adapter });
}

export type DbClient = ReturnType<typeof createPrisma>;
