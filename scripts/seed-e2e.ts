/**
 * seed-e2e.ts
 *
 * One-shot idempotent seed script for e2e testing.
 *
 * Creates:
 *   1. An admin account (sub = E2E_ADMIN_SUB, default 00000000-0000-0000-0000-000000000001)
 *   2. An e2e test-user account (sub = E2E_USER_SUB, default 00000000-0000-0000-0000-000000000002)
 *   3. An admin API token for the admin account (deterministic, matches issue-test-session.ts)
 *   4. A sample "Language Profile" form with two pages and a `show_if` rule
 *   5. An event `language.profile.v1` bound to that form (non-optional)
 *
 * All operations are upsert-style (idempotent). Safe to run multiple times.
 *
 * Usage:
 *   DATABASE_URL=... pnpm tsx scripts/seed-e2e.ts
 */

import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';
import { v7 as uuidv7 } from 'uuid';

const prisma = new PrismaClient();

const ADMIN_SUB = process.env.E2E_ADMIN_SUB ?? '00000000-0000-0000-0000-000000000001';
const USER_SUB = process.env.E2E_USER_SUB ?? '00000000-0000-0000-0000-000000000002';
const ADMIN_TOKEN_SEED = process.env.E2E_ADMIN_TOKEN_SEED ?? 'e2e-admin-seed';
const EVENT_KEY = 'language.profile.v1';
const FORM_SLUG = 'language-profile-e2e';

function makeAdminTokenRaw(accountId: string): string {
  return crypto
    .createHash('sha256')
    .update(`${ADMIN_TOKEN_SEED}:${accountId}`)
    .digest('hex');
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function main(): Promise<void> {
  console.log('[seed-e2e] starting…');

  // ── 1. Admin account ───────────────────────────────────────────────────────
  await prisma.formAccountRole.upsert({
    where: { account_id_role: { account_id: ADMIN_SUB, role: 'admin' } },
    create: {
      id: uuidv7(),
      account_id: ADMIN_SUB,
      role: 'admin',
    },
    update: {},
  });
  console.log(`[seed-e2e] admin account role: ${ADMIN_SUB}`);

  // ── 2. Test-user account role ─────────────────────────────────────────────
  await prisma.formAccountRole.upsert({
    where: { account_id_role: { account_id: USER_SUB, role: 'viewer' } },
    create: {
      id: uuidv7(),
      account_id: USER_SUB,
      role: 'viewer',
    },
    update: {},
  });
  console.log(`[seed-e2e] test-user account role: ${USER_SUB}`);

  // ── 3. Admin API token ────────────────────────────────────────────────────
  const rawToken = makeAdminTokenRaw(ADMIN_SUB);
  const tokenHash = hashToken(rawToken);
  await prisma.formApiToken.upsert({
    where: { token_hash: tokenHash },
    create: {
      id: uuidv7(),
      name: 'e2e-admin-token',
      token_hash: tokenHash,
      type: 'admin',
      scopes_json: '["*"]',
    },
    update: {},
  });
  console.log(`[seed-e2e] admin API token seeded (raw: ${rawToken.slice(0, 8)}…)`);

  // ── 4. Language Profile form ──────────────────────────────────────────────
  const formSpec = {
    pages: [
      {
        id: 'pg_1',
        title: 'About you',
        show_if: null,
        fields: [
          {
            id: 'fld_languages',
            type: 'multiselect',
            label: 'Languages you speak',
            required: true,
            options: [
              { value: 'en', label: 'English' },
              { value: 'th', label: 'Thai' },
              { value: 'ja', label: 'Japanese' },
            ],
          },
        ],
      },
      {
        id: 'pg_2',
        title: 'Primary language',
        show_if: { '!!': [{ var: 'fld_languages' }] },
        fields: [
          {
            id: 'fld_primary_language',
            type: 'select',
            label: 'Primary language',
            required: true,
            options: [
              { value: 'en', label: 'English' },
              { value: 'th', label: 'Thai' },
              { value: 'ja', label: 'Japanese' },
            ],
          },
        ],
      },
    ],
    thank_you: {
      title: 'Thanks!',
      body_md: 'Your language profile is saved.',
      redirect_url_template: '{return_url}?event={event_key}&submission_id={submission_id}',
    },
    submit: { post_actions: ['mark_event_filled'] },
  };

  const existingForm = await prisma.formDefinition.findUnique({
    where: { slug: FORM_SLUG },
  });

  let formId: string;
  if (existingForm) {
    formId = existingForm.id;
    console.log(`[seed-e2e] form already exists: ${formId}`);
  } else {
    formId = uuidv7();
    await prisma.formDefinition.create({
      data: {
        id: formId,
        type: 'dynamic',
        title: 'Language Profile (E2E)',
        slug: FORM_SLUG,
        current_version: 1,
        owner_account_id: ADMIN_SUB,
      },
    });

    const schemaHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(formSpec))
      .digest('hex');

    await prisma.formVersion.create({
      data: {
        id: uuidv7(),
        form_id: formId,
        version: 1,
        spec_json: formSpec,
        schema_hash: schemaHash,
        is_current: true,
        published_by: ADMIN_SUB,
      },
    });
    console.log(`[seed-e2e] form created: ${formId} (slug: ${FORM_SLUG})`);
  }

  // ── 5. Event ──────────────────────────────────────────────────────────────
  await prisma.formEvent.upsert({
    where: { event_key: EVENT_KEY },
    create: {
      id: uuidv7(),
      event_key: EVENT_KEY,
      form_id: formId,
      current_version: 1,
      optional: false,
      description: 'Language profile collection event (e2e seed)',
    },
    update: { form_id: formId, current_version: 1 },
  });
  console.log(`[seed-e2e] event upserted: ${EVENT_KEY}`);

  console.log('[seed-e2e] done.');
}

main()
  .catch((err) => {
    console.error('[seed-e2e] error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
