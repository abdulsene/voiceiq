-- 039_business_hours_backfill.sql
-- Phase 3.1a — data migration: parse existing business_configs.business_hours
-- free-form text into structured business_hours table rows.
--
-- Companion to 038 (schema) — 038 shipped the empty table; this migration
-- populates it for the ~46 businesses that already carry a free-form
-- business_hours value.
--
-- Parser lives inline as a PL/pgSQL function parse_business_hours_text().
-- Matches the TypeScript parser at src/lib/business-hours/parser.ts on
-- the patterns observed in production (verified via SELECT before
-- writing this migration):
--
--   * "Monday-Friday 9AM-5PM"                        (most common)
--   * "Monday-Friday 9AM-6PM"
--   * "Tuesday-Saturday 10AM-7PM"
--   * "9-5 Mon-Fri"
--   * "9-5"
--   * "Monday-Friday 7AM-7PM, 24/7 Emergency"        (emergency appendix ignored)
--   * "Mon-Fri 9:00 AM - 5:00 PM"
--   * "Monday to Friday, 9am to 5pm"                 (uses " to " separator)
--   * "Mon, Tue, Wed, Thu, Fri, Sat 9:00 AM - 4:00 PM" (EZ Rentals)
--
-- Idempotent: skips businesses that already have rows in business_hours.
-- Safe to re-apply after adding new signup businesses; existing rows
-- unchanged.
--
-- Parse failures RAISE NOTICE (surfaces in Supabase logs) and skip the
-- business — the business will show up in the dashboard with empty hours
-- so the admin can set them manually.
--
-- day_of_week encoding: 0=Sunday .. 6=Saturday (matches Postgres
-- EXTRACT(DOW FROM ...) and JavaScript Date.getDay()).
--
-- Timezone: America/New_York default. No production business_hours text
-- observed to carry a tz string; multi-tz can go through the admin UI
-- once 3.1b ships.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- (1) Parser function — pure, no side effects. Returns 7 rows per call.
-- ─────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION parse_business_hours_text(
  input_text TEXT,
  default_tz TEXT DEFAULT 'America/New_York'
)
RETURNS TABLE(dow SMALLINT, opens_at_out TIME, closes_at_out TIME, tz_out TEXT, is_closed_out BOOLEAN)
LANGUAGE plpgsql
IMMUTABLE
AS $func$
DECLARE
  normalized      TEXT;
  primary_seg     TEXT;
  comma_pos       INT;
  day_range_m     TEXT[];
  day_word        TEXT;
  time_m          TEXT[];
  start_hour      INT;
  start_min       INT;
  start_ampm      TEXT;
  end_hour        INT;
  end_min         INT;
  end_ampm        TEXT;
  opens_val       TIME;
  closes_val      TIME;
  day_names       TEXT[] := ARRAY['sun','mon','tue','wed','thu','fri','sat'];
  start_dow       INT;
  end_dow         INT;
  open_dows       INT[] := ARRAY[]::INT[];
  d               INT;
BEGIN
  -- Empty input → all days closed (fallback, matches TS parser).
  IF input_text IS NULL OR btrim(input_text) = '' THEN
    FOR d IN 0..6 LOOP
      dow := d; opens_at_out := NULL; closes_at_out := NULL;
      tz_out := default_tz; is_closed_out := true;
      RETURN NEXT;
    END LOOP;
    RETURN;
  END IF;

  -- Normalize whitespace and en-dashes.
  normalized := regexp_replace(regexp_replace(btrim(input_text), '[–]', '-', 'g'), '\s+', ' ', 'g');

  -- Strip emergency appendix ("..., 24/7 Emergency") before other checks.
  comma_pos := position(',' in normalized);
  IF comma_pos > 0 AND (substring(normalized from comma_pos) ~* '24\s*/?\s*7|emergency') THEN
    primary_seg := btrim(substring(normalized for comma_pos - 1));
  ELSE
    primary_seg := normalized;
  END IF;

  -- 24/7 shorthand on the primary segment → all days 00:00-23:59.
  IF primary_seg ~* '(^|\s)24\s*/\s*7(\s|,|$)'
     OR primary_seg ~* '(^|\s)24\s*hours?(\s|$)'
     OR primary_seg ~* 'always\s*open' THEN
    FOR d IN 0..6 LOOP
      dow := d; opens_at_out := '00:00'::TIME; closes_at_out := '23:59'::TIME;
      tz_out := default_tz; is_closed_out := false;
      RETURN NEXT;
    END LOOP;
    RETURN;
  END IF;

  -- Time range: (\d{1,2})(:\d{2})?(am|pm)? (- | to) (\d{1,2})(:\d{2})?(am|pm)?
  -- Accepts both "-" and " to " as separators to handle "Monday to Friday,
  -- 9am to 5pm" (production sample).
  time_m := regexp_match(
    primary_seg,
    '(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?',
    'i'
  );

  IF time_m IS NULL THEN
    -- No time range parseable → all closed. Caller can set manually.
    FOR d IN 0..6 LOOP
      dow := d; opens_at_out := NULL; closes_at_out := NULL;
      tz_out := default_tz; is_closed_out := true;
      RETURN NEXT;
    END LOOP;
    RETURN;
  END IF;

  start_hour := time_m[1]::INT;
  start_min  := COALESCE(time_m[2]::INT, 0);
  start_ampm := lower(COALESCE(time_m[3], ''));
  end_hour   := time_m[4]::INT;
  end_min    := COALESCE(time_m[5]::INT, 0);
  end_ampm   := lower(COALESCE(time_m[6], ''));

  -- Convert to 24-hour.
  IF start_ampm = 'pm' AND start_hour < 12 THEN
    start_hour := start_hour + 12;
  ELSIF start_ampm = 'am' AND start_hour = 12 THEN
    start_hour := 0;
  ELSIF start_ampm = '' AND start_hour >= 1 AND start_hour <= 7 THEN
    -- Heuristic: "1..7" with no AM/PM is PM (afternoon).
    start_hour := start_hour + 12;
  END IF;

  IF end_ampm = 'pm' AND end_hour < 12 THEN
    end_hour := end_hour + 12;
  ELSIF end_ampm = 'am' AND end_hour = 12 THEN
    end_hour := 0;
  ELSIF end_ampm = '' AND end_hour >= 1 AND end_hour <= 7 THEN
    end_hour := end_hour + 12;
  END IF;

  -- Guard against silly out-of-range values.
  IF start_hour > 23 THEN start_hour := 23; END IF;
  IF end_hour > 23 THEN end_hour := 23; END IF;

  opens_val  := make_time(start_hour, start_min, 0);
  closes_val := make_time(end_hour, end_min, 0);

  -- Day range: "Monday-Friday", "Tuesday-Saturday", "Monday to Friday", "Mon-Fri".
  -- Accepts "-" and " to " as separators. First 3 letters of each side are
  -- looked up in day_names.
  day_range_m := regexp_match(
    primary_seg,
    '([a-z]{3,9})\s*(?:-|to)\s*([a-z]{3,9})',
    'i'
  );

  IF day_range_m IS NOT NULL THEN
    start_dow := array_position(day_names, lower(substring(day_range_m[1] for 3)));
    end_dow   := array_position(day_names, lower(substring(day_range_m[2] for 3)));
    IF start_dow IS NOT NULL AND end_dow IS NOT NULL THEN
      -- array_position is 1-indexed; convert to 0-indexed DOW.
      start_dow := start_dow - 1;
      end_dow   := end_dow - 1;
      d := start_dow;
      LOOP
        open_dows := open_dows || d;
        EXIT WHEN d = end_dow;
        d := (d + 1) % 7;
      END LOOP;
    END IF;
  END IF;

  -- Day list fallback: comma-separated day names ("Mon, Tue, Wed, ...").
  -- Only runs if day range didn't match; picks up EZ Rentals-style values.
  IF array_length(open_dows, 1) IS NULL THEN
    FOR day_word IN
      SELECT m[1] FROM regexp_matches(primary_seg, '([a-z]{3,9})', 'gi') AS m
    LOOP
      start_dow := array_position(day_names, lower(substring(day_word for 3)));
      IF start_dow IS NOT NULL AND NOT ((start_dow - 1) = ANY(open_dows)) THEN
        open_dows := open_dows || (start_dow - 1);
      END IF;
    END LOOP;
  END IF;

  -- Still empty (bare "9-5" case) → assume Mon-Fri.
  IF array_length(open_dows, 1) IS NULL THEN
    open_dows := ARRAY[1,2,3,4,5];
  END IF;

  -- Emit 7 rows.
  FOR d IN 0..6 LOOP
    dow := d;
    tz_out := default_tz;
    IF d = ANY(open_dows) THEN
      opens_at_out := opens_val;
      closes_at_out := closes_val;
      is_closed_out := false;
    ELSE
      opens_at_out := NULL;
      closes_at_out := NULL;
      is_closed_out := true;
    END IF;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$func$;

COMMENT ON FUNCTION parse_business_hours_text(TEXT, TEXT) IS
  'Phase 3.1a: PL/pgSQL companion to lib/business-hours/parser.ts. Parses free-form business_hours text ("Monday-Friday 9AM-5PM", "9-5", "Mon, Tue, Wed 9AM-4PM", "24/7", etc.) into 7 structured rows (one per day_of_week). Used by migration 039 backfill; also usable as an on-demand helper.';

-- ─────────────────────────────────────────────────────────────────────
-- (2) Backfill — iterate business_configs, insert into business_hours.
-- Skips businesses that already have rows (idempotent re-apply).
-- ─────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  biz             RECORD;
  parse_row       RECORD;
  ok_count        INT := 0;
  fail_count      INT := 0;
  skip_count      INT := 0;
BEGIN
  FOR biz IN
    SELECT bc.business_id, bc.business_hours
      FROM business_configs bc
     WHERE bc.business_hours IS NOT NULL
       AND btrim(bc.business_hours) != ''
       AND NOT EXISTS (
         SELECT 1 FROM business_hours bh WHERE bh.business_id = bc.business_id
       )
  LOOP
    BEGIN
      FOR parse_row IN
        SELECT * FROM parse_business_hours_text(biz.business_hours)
      LOOP
        INSERT INTO business_hours (
          business_id, day_of_week, opens_at, closes_at, timezone, is_closed
        ) VALUES (
          biz.business_id, parse_row.dow, parse_row.opens_at_out,
          parse_row.closes_at_out, parse_row.tz_out, parse_row.is_closed_out
        );
      END LOOP;
      ok_count := ok_count + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Log and skip. Sentry ingestion of Supabase logs picks these up.
      RAISE NOTICE 'Migration 039 backfill FAILED for business_id=% text=% error=%',
        biz.business_id, biz.business_hours, SQLERRM;
      fail_count := fail_count + 1;
    END;
  END LOOP;

  SELECT COUNT(*) INTO skip_count
    FROM business_configs bc
   WHERE bc.business_hours IS NOT NULL
     AND btrim(bc.business_hours) != ''
     AND EXISTS (SELECT 1 FROM business_hours bh WHERE bh.business_id = bc.business_id);

  RAISE NOTICE 'Migration 039 backfill complete: % ok, % failed, % skipped (already had rows)',
    ok_count, fail_count, skip_count;
END $$;

COMMIT;
