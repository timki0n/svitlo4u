CREATE TABLE `requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`street_id` integer NOT NULL,
	`house_id` integer NOT NULL,
	`address` text NOT NULL,
	`yasno_group` text,
	`can_admin` integer NOT NULL,
	`spare_phone` integer NOT NULL,
	`router_ok` integer NOT NULL,
	`wants_voltage` integer NOT NULL,
	`contact` text,
	`user_id` integer,
	`username` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `requests_by_time` ON `requests` (`created_at`);--> statement-breakpoint
CREATE TABLE `site_addresses` (
	`street_id` integer NOT NULL,
	`house_id` integer NOT NULL,
	`site_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`street_id`, `house_id`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `site_addresses_by_site` ON `site_addresses` (`site_id`);--> statement-breakpoint
CREATE TABLE `telegram_favorites` (
	`user_id` integer NOT NULL,
	`site_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `site_id`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
