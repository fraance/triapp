let prisma: any;

if (process.env.NODE_ENV === "production") {
  prisma = require("@prisma/client").PrismaClient;
} else {
  let globalWithPrisma = global as any;
  if (!globalWithPrisma.prisma) {
    globalWithPrisma.prisma = require("@prisma/client").PrismaClient;
  }
  prisma = globalWithPrisma.prisma;
}

export { prisma };
