// Idempotent seed for form-api.
// Run with: npm run prisma:seed  (or: DATABASE_URL=... npx tsx prisma/seed.ts)
//
// Seeds:
//   - 4 system roles: super-admin, editor, author, viewer
//   - Inline action/subject permissions per role (mirrors cms-api Permission shape)
// Does NOT seed: locales, sample forms, sample events — those are created via admin UI.

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error("[seed] DATABASE_URL environment variable is required");
}

const adapter = new PrismaPg(connectionString);
const prisma = new PrismaClient({ adapter });

// ---------------------------------------------------------------------------
// Role + permission definitions
// ---------------------------------------------------------------------------

interface PermissionDef {
  action: string;
  subject: string;
  conditionsJson?: Record<string, unknown>;
}

interface RoleDef {
  name: string;
  description: string;
  permissions: PermissionDef[];
}

const ROLES: RoleDef[] = [
  {
    name: "super-admin",
    description: "Full access to all form-service resources",
    permissions: [{ action: "*", subject: "*" }],
  },
  {
    name: "editor",
    description:
      "Build and manage forms; publish versions; read submissions; manage events and webhooks",
    permissions: [
      { action: "read", subject: "form:*" },
      { action: "write", subject: "form:*" },
      { action: "publish", subject: "form:*" },
    ],
  },
  {
    name: "author",
    description: "Read all resources; write resources they own",
    permissions: [
      { action: "read", subject: "*" },
      { action: "write", subject: "owned" },
    ],
  },
  {
    name: "viewer",
    description: "Read-only access to all form-service resources",
    permissions: [{ action: "read", subject: "*" }],
  },
];

// ---------------------------------------------------------------------------

async function main() {
  console.log("[seed] Starting…");

  for (const roleDef of ROLES) {
    // Upsert the role itself (model: Role -> table: form_role)
    const role = await prisma.role.upsert({
      where: { name: roleDef.name },
      update: {
        description: roleDef.description,
        isSystem: true,
      },
      create: {
        name: roleDef.name,
        description: roleDef.description,
        isSystem: true,
      },
    });
    console.log(`[seed] role: ${role.name} (id=${role.id})`);

    // For each expected permission, upsert by (roleId, action, subject).
    // Permission has no unique constraint on (roleId, action, subject),
    // so we use findFirst + create to achieve idempotency without duplicates.
    for (const perm of roleDef.permissions) {
      const existing = await prisma.permission.findFirst({
        where: {
          roleId: role.id,
          action: perm.action,
          subject: perm.subject,
        },
      });

      if (!existing) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const permData: any = {
          roleId: role.id,
          action: perm.action,
          subject: perm.subject,
        };
        if (perm.conditionsJson !== undefined) {
          permData.conditionsJson = perm.conditionsJson;
        }
        await prisma.permission.create({ data: permData });
        console.log(
          `[seed]   + permission: ${perm.action} on ${perm.subject}`
        );
      } else {
        console.log(
          `[seed]   ~ permission exists: ${perm.action} on ${perm.subject}`
        );
      }
    }
  }

  console.log("[seed] Done.");
}

main()
  .catch((err) => {
    console.error("[seed] Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
