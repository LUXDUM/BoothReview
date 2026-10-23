CREATE TABLE IF NOT EXISTS "author_blocks" (
	"author_hash" char(64) PRIMARY KEY NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
