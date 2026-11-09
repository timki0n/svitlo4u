CREATE TABLE `game_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` text NOT NULL,
	`session` integer NOT NULL,
	`user_id` integer NOT NULL,
	`points` integer NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `game_ledger_by_session` ON `game_ledger` (`site_id`,`session`);--> statement-breakpoint
CREATE INDEX `game_ledger_by_time` ON `game_ledger` (`site_id`,`at`);--> statement-breakpoint
CREATE TABLE `game_unlocks` (
	`site_id` text NOT NULL,
	`session` integer NOT NULL,
	`door` integer NOT NULL,
	`part` integer NOT NULL,
	`user_id` integer NOT NULL,
	`unlocked_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `session`, `door`, `part`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_unlocks_one_part` ON `game_unlocks` (`site_id`,`session`,`door`,`user_id`);