CREATE TABLE "sector_routines" (
	"id" text PRIMARY KEY NOT NULL,
	"sector_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"name" text NOT NULL,
	"objective" text NOT NULL,
	"interval_minutes" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_enqueued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sector_routines" ADD CONSTRAINT "sector_routines_sector_id_sectors_id_fk" FOREIGN KEY ("sector_id") REFERENCES "public"."sectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sector_routines" ADD CONSTRAINT "sector_routines_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sector_routines_sector_idx" ON "sector_routines" USING btree ("sector_id");