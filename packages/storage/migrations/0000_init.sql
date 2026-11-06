CREATE TABLE `detector_state` (
	`site_id` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `heartbeat_minutes` (
	`site_id` text NOT NULL,
	`device_id` text NOT NULL,
	`minute` integer NOT NULL,
	`packets` integer DEFAULT 0 NOT NULL,
	`max_gap_ms` integer DEFAULT 0 NOT NULL,
	`reboots` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`device_id`, `minute`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `notification_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` text NOT NULL,
	`channel` text NOT NULL,
	`target` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`dedupe_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_outbox_dedupe` ON `notification_outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notification_outbox_due` ON `notification_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `outages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer,
	`start_approximate` integer DEFAULT false NOT NULL,
	`false_alarm` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outages_site_start` ON `outages` (`site_id`,`start`);--> statement-breakpoint
CREATE INDEX `outages_site_end` ON `outages` (`site_id`,`end`);--> statement-breakpoint
CREATE TABLE `power_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` text NOT NULL,
	`type` text NOT NULL,
	`at` integer NOT NULL,
	`until` integer,
	`detected_at` integer NOT NULL,
	`reason` text,
	`approximate` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `power_events_site_at` ON `power_events` (`site_id`,`at`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`endpoint` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`preferences_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reminder_log` (
	`site_id` text NOT NULL,
	`key` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `key`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `schedule_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` text NOT NULL,
	`date` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`status` text NOT NULL,
	`raw_status` text NOT NULL,
	`slots_json` text NOT NULL,
	`signature` text NOT NULL,
	`updated_on` text,
	`source` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `schedule_snapshots_site_date` ON `schedule_snapshots` (`site_id`,`date`,`fetched_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_snapshots_version` ON `schedule_snapshots` (`site_id`,`date`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tz` text NOT NULL,
	`yasno_region` integer NOT NULL,
	`yasno_dso` integer NOT NULL,
	`yasno_group` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `telegram_subscribers` (
	`site_id` text NOT NULL,
	`chat_id` integer NOT NULL,
	`thread_id` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `chat_id`, `thread_id`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `voltage_samples` (
	`site_id` text NOT NULL,
	`t` integer NOT NULL,
	`voltage` real NOT NULL,
	PRIMARY KEY(`site_id`, `t`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
