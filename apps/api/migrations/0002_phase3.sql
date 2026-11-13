CREATE TABLE "mail_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"source" text NOT NULL,
	"destinations" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_aliases_source_unique" UNIQUE("source")
);
--> statement-breakpoint
CREATE TABLE "mail_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"catch_all" text,
	"dkim_record" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_domains_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"address" text NOT NULL,
	"password_hash" text NOT NULL,
	"quota_mb" integer DEFAULT 1024 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "reseller_limits" (
	"user_id" text PRIMARY KEY NOT NULL,
	"max_accounts" integer NOT NULL,
	"max_disk_mb" integer NOT NULL,
	"package_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "reseller_id" text;--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "max_mailboxes" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "name" text DEFAULT 'Main server' NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "is_main" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "queue_suffix" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "wg_public_key" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "wg_address" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "join_token_hash" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "join_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_aliases" ADD CONSTRAINT "mail_aliases_domain_id_mail_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."mail_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_domain_id_mail_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."mail_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_limits" ADD CONSTRAINT "reseller_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_reseller_id_users_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "servers" SET "is_main" = true, "queue_suffix" = '' WHERE "id" = (SELECT "id" FROM "servers" ORDER BY "created_at" LIMIT 1) AND NOT EXISTS (SELECT 1 FROM "servers" WHERE "is_main");
