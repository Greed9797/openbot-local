CREATE TYPE "public"."agent_run_origin" AS ENUM('web', 'telegram', 'api');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'running', 'waiting_model', 'executing', 'waiting_approval', 'waiting_human', 'paused', 'needs_reconciliation', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."agent_run_step_kind" AS ENUM('observation', 'decision', 'action', 'execution', 'note', 'delegated');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'denied', 'expired', 'consumed');--> statement-breakpoint
CREATE TYPE "public"."artifact_classification" AS ENUM('public', 'internal', 'sensitive', 'secret');--> statement-breakpoint
CREATE TYPE "public"."artifact_protection" AS ENUM('none', 'masked', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('telegram', 'web');--> statement-breakpoint
CREATE TABLE "agent_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" "agent_run_step_kind" NOT NULL,
	"status" text NOT NULL,
	"observation" jsonb,
	"model_decision" jsonb,
	"proposed_action" jsonb,
	"policy_decision" jsonb,
	"execution_result" jsonb,
	"artifact_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" text NOT NULL,
	"user_id" text,
	"thread_id" text,
	"origin" "agent_run_origin" DEFAULT 'web' NOT NULL,
	"source_message_id" text,
	"idempotency_key" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"objective" text NOT NULL,
	"status" "agent_run_status" DEFAULT 'queued' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"budget" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"lease_owner" text,
	"lease_generation" bigint DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"checkpoint" jsonb,
	"error" jsonb,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_profile_leases" (
	"profile_id" text PRIMARY KEY NOT NULL,
	"run_id" uuid,
	"owner" text NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"transport" text NOT NULL,
	"model_id" text NOT NULL,
	"base_url" text,
	"credential_id" uuid,
	"capabilities" jsonb NOT NULL,
	"limits" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"tested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"channel" "notification_channel" NOT NULL,
	"destination" jsonb NOT NULL,
	"event_type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid,
	"actor_user_id" text,
	"action_hash" text NOT NULL,
	"action" jsonb NOT NULL,
	"destination" text,
	"expected_effect" text,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"hash" text NOT NULL,
	"bytes" integer NOT NULL,
	"storage_path" text NOT NULL,
	"classification" "artifact_classification" DEFAULT 'internal' NOT NULL,
	"protection" "artifact_protection" DEFAULT 'none' NOT NULL,
	"retention_until" timestamp with time zone,
	"allowed_destinations" text[] NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_bot_id" text NOT NULL,
	"update_id" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "telegram_pairing_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_approvals" ADD CONSTRAINT "run_approvals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_events_run_seq_idx" ON "agent_run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "agent_run_events_run_idx" ON "agent_run_events" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_steps_run_seq_idx" ON "agent_run_steps" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "agent_run_steps_run_idx" ON "agent_run_steps" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_idempotency_key_idx" ON "agent_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_runs_status_created_idx" ON "agent_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_bot_created_idx" ON "agent_runs" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_user_created_idx" ON "agent_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "browser_profile_leases_run_idx" ON "browser_profile_leases" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "model_configurations_provider_idx" ON "model_configurations" USING btree ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_channel_dedupe_idx" ON "notification_outbox" USING btree ("channel","dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_outbox_delivery_idx" ON "notification_outbox" USING btree ("delivered_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX "run_approvals_run_status_idx" ON "run_approvals" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "run_artifacts_run_idx" ON "run_artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_artifacts_retention_idx" ON "run_artifacts" USING btree ("retention_until");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_bindings_user_chat_idx" ON "telegram_bindings" USING btree ("telegram_user_id","chat_id");--> statement-breakpoint
CREATE INDEX "telegram_bindings_user_idx" ON "telegram_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_inbox_bot_update_idx" ON "telegram_inbox" USING btree ("telegram_bot_id","update_id");--> statement-breakpoint
CREATE INDEX "telegram_inbox_pending_idx" ON "telegram_inbox" USING btree ("processed_at");