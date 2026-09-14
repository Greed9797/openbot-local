CREATE TABLE "sector_bots" (
	"bot_id" text PRIMARY KEY NOT NULL,
	"sector_id" text NOT NULL,
	"account_label" text,
	"seller_url" text,
	"account_ordinal" integer,
	"enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sector_enrollments" (
	"email" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sector_id" text,
	"role" "role" DEFAULT 'user' NOT NULL,
	"expires_at" timestamp with time zone,
	"accepted_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sector_enrollments_sector_id_unique" UNIQUE("sector_id")
);
--> statement-breakpoint
CREATE TABLE "sectors" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text,
	"last_dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sectors_owner_user_id_unique" UNIQUE("owner_user_id")
);
--> statement-breakpoint
ALTER TABLE "sector_bots" ADD CONSTRAINT "sector_bots_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sector_bots" ADD CONSTRAINT "sector_bots_sector_id_sectors_id_fk" FOREIGN KEY ("sector_id") REFERENCES "public"."sectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sector_enrollments" ADD CONSTRAINT "sector_enrollments_sector_id_sectors_id_fk" FOREIGN KEY ("sector_id") REFERENCES "public"."sectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sector_enrollments" ADD CONSTRAINT "sector_enrollments_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sectors" ADD CONSTRAINT "sectors_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sector_bots_sector_idx" ON "sector_bots" USING btree ("sector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sector_bots_sector_ordinal_idx" ON "sector_bots" USING btree ("sector_id","account_ordinal");