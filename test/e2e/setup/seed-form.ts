/**
 * E2E seed — creates one published public_anonymous form used by
 * submit-public-form.spec.ts.
 *
 * Skips gracefully when DATABASE_URL is not set (local dev without a DB).
 *
 * Run:
 *   npx tsx test/e2e/setup/seed-form.ts
 *
 * The script is idempotent: it upserts by slug so re-runs are safe.
 */

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const SLUG = 'e2e-smoke-form';
const OWNER_ACCOUNT_ID = 'e2e-ci-seed';

if (!process.env.DATABASE_URL) {
  console.log('[seed-form] DATABASE_URL not set — skipping seed.');
  process.exit(0);
}

const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
});

const spec = {
  pages: [
    {
      id: 'pg_1',
      title: 'Smoke test',
      show_if: null,
      fields: [
        {
          id: 'fld_name',
          type: 'text',
          label: 'Your name',
          required: true,
        },
      ],
    },
  ],
  thank_you: {
    title: 'Thank you!',
    body_md: 'Your response has been recorded.',
    redirect_url_template: '',
  },
  submit: { post_actions: [] },
};

async function main() {
  // Upsert the form definition (match on slug).
  const existing = await prisma.formDefinition.findFirst({
    where: { slug: SLUG },
  });

  let formId: string;

  if (existing) {
    formId = existing.id;
    console.log(`[seed-form] Found existing form: ${formId}`);
  } else {
    const form = await prisma.formDefinition.create({
      data: {
        type: 'dynamic',
        title: 'E2E Smoke Form',
        slug: SLUG,
        currentVersion: 1,
        ownerAccountId: OWNER_ACCOUNT_ID,
      },
    });
    formId = form.id;
    console.log(`[seed-form] Created form: ${formId}`);
  }

  // Ensure a current published version exists.
  const existingVersion = await prisma.formVersion.findFirst({
    where: { formId, isCurrent: true },
  });

  if (!existingVersion) {
    await prisma.formVersion.create({
      data: {
        formId,
        version: 1,
        specJson: spec,
        schemaHash: crypto
          .createHash('sha256')
          .update(JSON.stringify(spec))
          .digest('hex'),
        publishedAt: new Date(),
        publishedBy: OWNER_ACCOUNT_ID,
        isCurrent: true,
      },
    });
    console.log('[seed-form] Created published version 1.');
  } else {
    console.log('[seed-form] Published version already exists — skipping.');
  }

  console.log(`[seed-form] Done. Form slug: ${SLUG}`);
}

main()
  .catch((err) => {
    console.error('[seed-form] Error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
