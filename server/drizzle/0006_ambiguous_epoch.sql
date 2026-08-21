CREATE TABLE "local_thread_history" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"user_id" text,
	"messages" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sso_providers" DROP CONSTRAINT "sso_providers_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "issuer" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "local_thread_history_updated_at_idx" ON "local_thread_history" USING btree ("updated_at");--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;