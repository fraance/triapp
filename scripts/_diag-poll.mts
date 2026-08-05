import "../tests/env.mts";
import { prisma } from "../lib/prisma";
async function main() {
  const users = await prisma.user.findMany({ select: { id: true, email: true }, orderBy: { createdAt: "asc" } });
  for (const u of users) {
    const plans = await prisma.trainingPlan.findMany({ where: { userId: u.id }, orderBy: { createdAt: "desc" }, select: { id: true, startDate: true, weekCount: true, detailedWeeks: true, createdAt: true } });
    const acts = await prisma.stravaActivity.count({ where: { userId: u.id } });
    console.log(u.email, "plans:", plans.length, "activities:", acts);
  }
}
main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); process.exit(1); });
