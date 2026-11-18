CREATE TABLE `hub_health` (
	`hub_id` text NOT NULL,
	`t` integer NOT NULL,
	`boot` text NOT NULL,
	`wifi_rssi` integer,
	`wifi_channel` integer,
	`drops` integer NOT NULL,
	`drop_reason` integer NOT NULL,
	`last_down` real NOT NULL,
	`kicks` integer NOT NULL,
	`lost` integer NOT NULL,
	`redone` integer NOT NULL,
	`plug_rssi` integer,
	`plug_gaps` integer,
	PRIMARY KEY(`hub_id`, `t`)
);
