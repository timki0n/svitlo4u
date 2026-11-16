CREATE TABLE `telegram_chats` (
	`chat_id` integer PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text,
	`added_by` integer,
	`status` text NOT NULL,
	`can_delete` integer DEFAULT false NOT NULL,
	`can_post` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
