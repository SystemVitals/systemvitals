import {
  inspectOrganizationWorkspaces,
  PrismaClient,
} from "../src/index";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  try {
    const incompatible = await inspectOrganizationWorkspaces(prisma);
    if (incompatible.length > 0) {
      console.error(JSON.stringify(incompatible));
      process.exitCode = 1;
      return;
    }
    console.log("Organization workspace preflight passed.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("Organization workspace preflight failed.");
  process.exitCode = 1;
});
