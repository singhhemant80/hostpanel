ALTER TABLE "sites" ADD COLUMN "processes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "redis" boolean DEFAULT false NOT NULL;