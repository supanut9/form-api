// Idempotent seed for form-api.
// Run with: npm run prisma:seed  (or: DATABASE_URL=... npx tsx prisma/seed.ts)
//
// Seeds:
//   - 4 system roles: super-admin, editor, author, viewer
//   - Inline action/subject permissions per role (mirrors cms-api Permission shape)
//   - 8 built-in marketplace templates (skipped when SEED_TEMPLATES=false)
// Does NOT seed: locales, sample forms, sample events — those are created via admin UI.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
    permissions: [
      { action: "*", subject: "*" },
      { action: "manage", subject: "FormTemplate" },
    ],
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
// Built-in template definitions
// ---------------------------------------------------------------------------

interface TemplateDef {
  slug: string;
  description: string;
  category: string;
  featuredOrder: number;
}

const TEMPLATES: TemplateDef[] = [
  {
    slug: "rsvp",
    description: "Collect RSVPs for weddings or events with dietary and party-size fields.",
    category: "rsvp",
    featuredOrder: 1,
  },
  {
    slug: "contact",
    description: "A clean contact-us form with subject routing and message field.",
    category: "contact",
    featuredOrder: 2,
  },
  {
    slug: "nps",
    description: "NPS survey with 0–10 score, branching follow-up, and detractor/promoter buckets.",
    category: "nps",
    featuredOrder: 3,
  },
  {
    slug: "lead-capture",
    description: "B2B lead form capturing company details, use case, and consent.",
    category: "lead",
    featuredOrder: 4,
  },
  {
    slug: "signup",
    description: "Lightweight newsletter or waitlist signup with interest-area preferences.",
    category: "signup",
    featuredOrder: 5,
  },
  {
    slug: "feedback",
    description: "Two-page product feedback form covering satisfaction, likes, and recommendation.",
    category: "feedback",
    featuredOrder: 6,
  },
  {
    slug: "survey",
    description: "General 3-page survey covering demographics, usage habits, and open feedback.",
    category: "survey",
    featuredOrder: 7,
  },
  {
    slug: "registration",
    description: "Event registration with session choice, dietary needs, and conditional accommodation.",
    category: "registration",
    featuredOrder: 8,
  },
];

// Resolve the templates directory relative to this file.
// Works for both `tsx` (ESM, import.meta) and older CommonJS paths.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, "seed", "templates");

// ---------------------------------------------------------------------------

async function main() {
  console.log("[seed] Starting…");

  // ── Roles & permissions ──────────────────────────────────────────────────

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

  // ── Built-in templates ───────────────────────────────────────────────────

  if (process.env["SEED_TEMPLATES"] !== "false") {
    console.log("[seed] Seeding built-in templates…");

    for (const tplDef of TEMPLATES) {
      const filePath = join(TEMPLATES_DIR, `${tplDef.slug}.json`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const specJson = JSON.parse(readFileSync(filePath, "utf-8")) as any;
      const title = typeof specJson["title"] === "string" ? specJson["title"] : tplDef.slug;

      await prisma.formTemplate.upsert({
        where: { slug: tplDef.slug },
        update: {
          title,
          description: tplDef.description,
          category: tplDef.category,
          featuredOrder: tplDef.featuredOrder,
          specJson,
        },
        create: {
          slug: tplDef.slug,
          title,
          description: tplDef.description,
          category: tplDef.category,
          featuredOrder: tplDef.featuredOrder,
          specJson,
        },
      });
      console.log(`[seed]   + template: ${tplDef.slug} (featured=${tplDef.featuredOrder})`);
    }

    console.log(`[seed] ${TEMPLATES.length} templates seeded.`);
  } else {
    console.log("[seed] Skipping templates (SEED_TEMPLATES=false).");
  }

  console.log("[seed] Done.");
}

main()
  .catch((err) => {
    console.error("[seed] Fatal error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
