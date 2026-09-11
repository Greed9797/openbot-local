CREATE TYPE "public"."run_message_author" AS ENUM('person', 'system');--> statement-breakpoint
CREATE TABLE "agent_run_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"author" "run_message_author" NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"actor_user_id" text,
	"step_seq" integer,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_messages" ADD CONSTRAINT "agent_run_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_messages_run_seq_idx" ON "agent_run_messages" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "agent_run_messages_pending_idx" ON "agent_run_messages" USING btree ("run_id","delivered_at");