CREATE TABLE `hub_boots` (
	`hub_id` text NOT NULL,
	`boot` text NOT NULL,
	`t` integer NOT NULL,
	`started_at` integer NOT NULL,
	`rst` text NOT NULL,
	`why` text,
	`fw` text,
	PRIMARY KEY(`hub_id`, `boot`)
);
--> statement-breakpoint
CREATE TABLE `hub_silences` (
	`hub_id` text NOT NULL,
	`boot` text NOT NULL,
	`up_ms` integer NOT NULL,
	`t` integer NOT NULL,
	`len_ms` integer NOT NULL,
	`reads_ok` integer NOT NULL,
	`reads_failed` integer NOT NULL,
	`held_ms` integer NOT NULL,
	`reports` integer NOT NULL,
	`conns` integer NOT NULL,
	`drops` integer NOT NULL,
	`since_report_ms` integer,
	`end_since_report_ms` integer,
	`end` text NOT NULL,
	`off` integer NOT NULL,
	`saved` integer NOT NULL,
	`plug_rssi` integer,
	PRIMARY KEY(`hub_id`, `boot`, `up_ms`)
);
