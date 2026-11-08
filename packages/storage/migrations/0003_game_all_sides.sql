-- The game now has every side of the tower, numbered round it; the street side gained two windows
-- per storey (no galleries there): its old windows 1-8 are now 1, 2, 4, 5, 6, 7, 9, 10.
UPDATE `game_solves` SET `col` = `col` + 100;
--> statement-breakpoint
UPDATE `game_solves` SET `col` = CASE `col`
	WHEN 101 THEN 1 WHEN 102 THEN 2 WHEN 103 THEN 4 WHEN 104 THEN 5
	WHEN 105 THEN 6 WHEN 106 THEN 7 WHEN 107 THEN 9 WHEN 108 THEN 10
	ELSE `col` - 100 END;
