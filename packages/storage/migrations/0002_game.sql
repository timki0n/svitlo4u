CREATE TABLE `game_players` (
	`site_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text,
	`username` text,
	`avatar` text,
	`avatar_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `user_id`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `game_solves` (
	`site_id` text NOT NULL,
	`session` integer NOT NULL,
	`floor` integer NOT NULL,
	`col` integer NOT NULL,
	`user_id` integer NOT NULL,
	`points` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`solved_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `session`, `floor`, `col`, `user_id`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `game_solves_by_time` ON `game_solves` (`site_id`,`solved_at`);