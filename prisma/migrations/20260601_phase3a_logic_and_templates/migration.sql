-- Phase 3A migration: form_templates + form_template_uses
-- Applies on top of: 20260523000000_add_delivered_at

-- CreateTable: form_templates
CREATE TABLE "form_templates" (
    "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id"   UUID,
    "slug"           TEXT         NOT NULL,
    "title"          TEXT         NOT NULL,
    "description"    TEXT,
    "spec_json"      JSONB        NOT NULL,
    "category"       TEXT         NOT NULL,
    "featured_order" INTEGER,
    "created_by"     UUID,
    "created_at"     TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable: form_template_uses
CREATE TABLE "form_template_uses" (
    "template_id" UUID        NOT NULL,
    "form_id"     UUID        NOT NULL,
    "used_at"     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_template_uses_pkey" PRIMARY KEY ("template_id", "form_id")
);

-- CreateUniqueIndex on form_templates.slug
CREATE UNIQUE INDEX "form_templates_slug_key" ON "form_templates"("slug");

-- CreateIndex on form_templates(category, featured_order) for marketplace ordering
CREATE INDEX "form_templates_category_featured_order_idx"
    ON "form_templates"("category", "featured_order");

-- AddForeignKey: form_template_uses.template_id -> form_templates.id (CASCADE)
ALTER TABLE "form_template_uses"
    ADD CONSTRAINT "form_template_uses_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "form_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
