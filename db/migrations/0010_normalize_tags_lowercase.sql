PRAGMA foreign_keys = OFF;

-- Normalize JSON tag arrays on STORIES.
UPDATE STORIES
SET TAGS_JSON = COALESCE(
  (
    SELECT json_group_array(tag)
    FROM (
      SELECT LOWER(TRIM(j.value)) AS tag
      FROM json_each(COALESCE(STORIES.TAGS_JSON, '[]')) j
      WHERE j.type = 'text' AND TRIM(j.value) != ''
      GROUP BY LOWER(TRIM(j.value))
      ORDER BY tag
    )
  ),
  '[]'
);

UPDATE STORIES
SET USER_TAGS_JSON = COALESCE(
  (
    SELECT json_group_array(tag)
    FROM (
      SELECT LOWER(TRIM(j.value)) AS tag
      FROM json_each(COALESCE(STORIES.USER_TAGS_JSON, '[]')) j
      WHERE j.type = 'text' AND TRIM(j.value) != ''
      GROUP BY LOWER(TRIM(j.value))
      ORDER BY tag
    )
  ),
  '[]'
);

-- Rebuild canonical indexed tags from normalized STORIES.TAGS_JSON.
DELETE FROM STORY_TAGS;
DELETE FROM TAGS;

INSERT OR IGNORE INTO TAGS (TAG)
SELECT DISTINCT normalized.tag
FROM (
  SELECT st.STORY_ID AS STORY_ID, LOWER(TRIM(j.value)) AS tag
  FROM STORIES st, json_each(COALESCE(st.TAGS_JSON, '[]')) j
  WHERE j.type = 'text' AND TRIM(j.value) != ''
  GROUP BY st.STORY_ID, LOWER(TRIM(j.value))
) normalized
ORDER BY normalized.tag;

INSERT OR IGNORE INTO STORY_TAGS (STORY_ID, TAG)
SELECT normalized.STORY_ID, normalized.tag
FROM (
  SELECT st.STORY_ID AS STORY_ID, LOWER(TRIM(j.value)) AS tag
  FROM STORIES st, json_each(COALESCE(st.TAGS_JSON, '[]')) j
  WHERE j.type = 'text' AND TRIM(j.value) != ''
  GROUP BY st.STORY_ID, LOWER(TRIM(j.value))
) normalized
ORDER BY normalized.STORY_ID, normalized.tag;

-- Rebuild user tag tables using both STORY_USER_TAGS and STORIES.USER_TAGS_JSON.
CREATE TABLE IF NOT EXISTS _TMP_STORY_USER_TAGS (
  STORY_ID TEXT NOT NULL,
  TAG TEXT NOT NULL,
  PRIMARY KEY (STORY_ID, TAG)
);

DELETE FROM _TMP_STORY_USER_TAGS;

INSERT OR IGNORE INTO _TMP_STORY_USER_TAGS (STORY_ID, TAG)
SELECT STORY_ID, LOWER(TRIM(TAG)) AS TAG
FROM STORY_USER_TAGS
WHERE TRIM(TAG) != '';

INSERT OR IGNORE INTO _TMP_STORY_USER_TAGS (STORY_ID, TAG)
SELECT s.STORY_ID, LOWER(TRIM(j.value)) AS TAG
FROM STORIES s, json_each(COALESCE(s.USER_TAGS_JSON, '[]')) j
WHERE j.type = 'text' AND TRIM(j.value) != '';

DELETE FROM STORY_USER_TAGS;
DELETE FROM USER_TAGS;

INSERT OR IGNORE INTO USER_TAGS (TAG)
SELECT DISTINCT TAG
FROM _TMP_STORY_USER_TAGS
ORDER BY TAG;

INSERT OR IGNORE INTO STORY_USER_TAGS (STORY_ID, TAG)
SELECT STORY_ID, TAG
FROM _TMP_STORY_USER_TAGS
ORDER BY STORY_ID, TAG;

DROP TABLE _TMP_STORY_USER_TAGS;

-- Re-sync JSON arrays from normalized relational tables.
UPDATE STORIES
SET TAGS_JSON = COALESCE(
  (
    SELECT json_group_array(tag)
    FROM (
      SELECT st.TAG AS tag
      FROM STORY_TAGS st
      WHERE st.STORY_ID = STORIES.STORY_ID
      GROUP BY st.TAG
      ORDER BY st.TAG
    )
  ),
  '[]'
);

UPDATE STORIES
SET USER_TAGS_JSON = COALESCE(
  (
    SELECT json_group_array(tag)
    FROM (
      SELECT su.TAG AS tag
      FROM STORY_USER_TAGS su
      WHERE su.STORY_ID = STORIES.STORY_ID
      GROUP BY su.TAG
      ORDER BY su.TAG
    )
  ),
  '[]'
);

PRAGMA foreign_keys = ON;
