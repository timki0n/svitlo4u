CREATE TABLE `hubs` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text,
	`site_id` text,
	`owner_user_id` integer,
	`firmware` text DEFAULT 'latest' NOT NULL,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `hubs_by_owner` ON `hubs` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `telegram_users` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`site_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `sites` ADD `access` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `origin` text DEFAULT 'config' NOT NULL;