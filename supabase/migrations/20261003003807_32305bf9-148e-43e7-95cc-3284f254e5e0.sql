CREATE TYPE public.mastery_state AS ENUM ('new','learning','familiar','strong','mastered');
CREATE TYPE public.skill_kind AS ENUM ('recognition','listening','reading','writing','speaking','recall','sentence_usage','form');

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- profiles
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  display_name text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile read" ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = auth.uid());
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE TRIGGER profiles_touch BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- learners
CREATE TABLE public.learners (
  device_id text PRIMARY KEY DEFAULT (auth.uid())::text,
  display_name text NOT NULL DEFAULT '',
  native_language text NOT NULL DEFAULT 'en',
  learning_language text NOT NULL DEFAULT 'es',
  daily_goal_minutes integer NOT NULL DEFAULT 10,
  streak integer NOT NULL DEFAULT 0,
  longest_streak integer NOT NULL DEFAULT 0,
  audio_autoplay boolean NOT NULL DEFAULT true,
  notifications_enabled boolean NOT NULL DEFAULT false,
  onboarding_completed boolean NOT NULL DEFAULT false,
  avatar_path text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.learners TO authenticated;
GRANT ALL ON public.learners TO service_role;
ALTER TABLE public.learners ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own learner" ON public.learners FOR ALL TO authenticated USING (device_id = (auth.uid())::text) WITH CHECK (device_id = (auth.uid())::text);

-- word_sets
CREATE TABLE public.word_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text NOT NULL DEFAULT (auth.uid())::text,
  name text NOT NULL,
  target_language text NOT NULL DEFAULT 'es',
  native_language text NOT NULL DEFAULT 'en',
  is_demo boolean NOT NULL DEFAULT false,
  review_stage integer NOT NULL DEFAULT 0,
  last_reviewed_at timestamptz,
  next_review_at timestamptz,
  forms_review_stage integer NOT NULL DEFAULT 0,
  forms_last_reviewed_at timestamptz,
  forms_next_review_at timestamptz,
  forms_generated_at timestamptz,
  last_practiced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX word_sets_device_idx ON public.word_sets (device_id, target_language, created_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.word_sets TO authenticated;
GRANT ALL ON public.word_sets TO service_role;
ALTER TABLE public.word_sets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own sets" ON public.word_sets FOR ALL TO authenticated USING (device_id = (auth.uid())::text) WITH CHECK (device_id = (auth.uid())::text);

CREATE OR REPLACE FUNCTION public.owns_set(_set_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.word_sets WHERE id = _set_id AND device_id = (auth.uid())::text)
$$;

-- words
CREATE TABLE public.words (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES public.word_sets(id) ON DELETE CASCADE,
  text text NOT NULL,
  translation text,
  meaning text,
  meaning_options jsonb,
  pronunciation text,
  part_of_speech text,
  alternative_parts_of_speech text[] NOT NULL DEFAULT '{}',
  forms_category text,
  difficulty integer,
  tags text[] NOT NULL DEFAULT '{}',
  position integer NOT NULL DEFAULT 0,
  analysis_status text NOT NULL DEFAULT 'pending',
  analysis_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX words_set_idx ON public.words (set_id, position);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.words TO authenticated;
GRANT ALL ON public.words TO service_role;
ALTER TABLE public.words ENABLE ROW LEVEL SECURITY;
CREATE POLICY "words of own sets" ON public.words FOR ALL TO authenticated USING (public.owns_set(set_id)) WITH CHECK (public.owns_set(set_id));

CREATE OR REPLACE FUNCTION public.owns_word(_word_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.words w JOIN public.word_sets s ON s.id = w.set_id WHERE w.id = _word_id AND s.device_id = (auth.uid())::text)
$$;

-- word_forms
CREATE TABLE public.word_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text NOT NULL DEFAULT (auth.uid())::text,
  set_id uuid NOT NULL REFERENCES public.word_sets(id) ON DELETE CASCADE,
  word_id uuid NOT NULL REFERENCES public.words(id) ON DELETE CASCADE,
  form_kind text NOT NULL DEFAULT 'form',
  form_label text NOT NULL,
  text text NOT NULL,
  translation text,
  pronunciation text,
  explanation text,
  example text,
  example_translation text,
  is_regular boolean,
  meaning_options jsonb,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX word_forms_set_idx ON public.word_forms (set_id, position);
CREATE INDEX word_forms_word_idx ON public.word_forms (word_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.word_forms TO authenticated;
GRANT ALL ON public.word_forms TO service_role;
ALTER TABLE public.word_forms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "forms of own sets" ON public.word_forms FOR ALL TO authenticated
  USING (device_id = (auth.uid())::text AND public.owns_set(set_id))
  WITH CHECK (device_id = (auth.uid())::text AND public.owns_set(set_id));

-- sentences
CREATE TABLE public.sentences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  word_id uuid NOT NULL REFERENCES public.words(id) ON DELETE CASCADE,
  text text NOT NULL,
  translation text,
  form text NOT NULL DEFAULT 'base',
  variation_index integer NOT NULL DEFAULT 0,
  is_ai_generated boolean NOT NULL DEFAULT true,
  word_hints jsonb NOT NULL DEFAULT '{}'::jsonb,
  word_glosses jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sentences_word_idx ON public.sentences (word_id, variation_index);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sentences TO authenticated;
GRANT ALL ON public.sentences TO service_role;
ALTER TABLE public.sentences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sentences of own words" ON public.sentences FOR ALL TO authenticated USING (public.owns_word(word_id)) WITH CHECK (public.owns_word(word_id));

-- learning_items
CREATE TABLE public.learning_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text NOT NULL DEFAULT (auth.uid())::text,
  set_id uuid NOT NULL REFERENCES public.word_sets(id) ON DELETE CASCADE,
  word_id uuid NOT NULL REFERENCES public.words(id) ON DELETE CASCADE,
  form_id uuid REFERENCES public.word_forms(id) ON DELETE CASCADE,
  sentence_id uuid REFERENCES public.sentences(id) ON DELETE CASCADE,
  skill public.skill_kind NOT NULL,
  form text NOT NULL DEFAULT 'base',
  state public.mastery_state NOT NULL DEFAULT 'new',
  mastery numeric NOT NULL DEFAULT 0,
  streak integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  mistakes integer NOT NULL DEFAULT 0,
  ease numeric NOT NULL DEFAULT 2.5,
  difficulty numeric NOT NULL DEFAULT 0,
  interval_days numeric NOT NULL DEFAULT 0,
  last_reviewed_at timestamptz,
  next_review_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX learning_items_set_idx ON public.learning_items (set_id);
CREATE INDEX learning_items_word_idx ON public.learning_items (word_id);
CREATE INDEX learning_items_form_idx ON public.learning_items (form_id);
CREATE INDEX learning_items_due_idx ON public.learning_items (device_id, next_review_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_items TO authenticated;
GRANT ALL ON public.learning_items TO service_role;
ALTER TABLE public.learning_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own items" ON public.learning_items FOR ALL TO authenticated
  USING (device_id = (auth.uid())::text)
  WITH CHECK (device_id = (auth.uid())::text AND public.owns_set(set_id));

-- practice_attempts (training_session_id has no FK: sessions are opened at the end)
CREATE TABLE public.practice_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text NOT NULL DEFAULT (auth.uid())::text,
  learning_item_id uuid NOT NULL REFERENCES public.learning_items(id) ON DELETE CASCADE,
  skill public.skill_kind NOT NULL,
  is_correct boolean NOT NULL,
  score numeric,
  response text,
  training_session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX practice_attempts_item_idx ON public.practice_attempts (learning_item_id, created_at);
CREATE INDEX practice_attempts_session_idx ON public.practice_attempts (training_session_id);
CREATE INDEX practice_attempts_device_idx ON public.practice_attempts (device_id, created_at);
GRANT SELECT, INSERT, DELETE ON public.practice_attempts TO authenticated;
GRANT ALL ON public.practice_attempts TO service_role;
ALTER TABLE public.practice_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own attempts read" ON public.practice_attempts FOR SELECT TO authenticated USING (device_id = (auth.uid())::text);
CREATE POLICY "own attempts insert" ON public.practice_attempts FOR INSERT TO authenticated WITH CHECK (device_id = (auth.uid())::text);
CREATE POLICY "own attempts delete" ON public.practice_attempts FOR DELETE TO authenticated USING (device_id = (auth.uid())::text);

-- pronunciation_attempts
CREATE TABLE public.pronunciation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text NOT NULL DEFAULT (auth.uid())::text,
  learning_item_id uuid NOT NULL REFERENCES public.learning_items(id) ON DELETE CASCADE,
  attempt_index integer NOT NULL DEFAULT 0,
  target_text text NOT NULL,
  transcript text NOT NULL DEFAULT '',
  score numeric NOT NULL DEFAULT 0,
  matched_words text[] NOT NULL DEFAULT '{}',
  missed_words text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pronunciation_attempts_item_idx ON public.pronunciation_attempts (learning_item_id);
GRANT SELECT, INSERT, DELETE ON public.pronunciation_attempts TO authenticated;
GRANT ALL ON public.pronunciation_attempts TO service_role;
ALTER TABLE public.pronunciation_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own pronunciation" ON public.pronunciation_attempts FOR ALL TO authenticated USING (device_id = (auth.uid())::text) WITH CHECK (device_id = (auth.uid())::text);

-- sentence_attempts
CREATE TABLE public.sentence_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text NOT NULL DEFAULT (auth.uid())::text,
  word_id uuid NOT NULL REFERENCES public.words(id) ON DELETE CASCADE,
  sentence text NOT NULL,
  is_correct boolean NOT NULL,
  corrected text,
  explanation text NOT NULL,
  training_session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sentence_attempts_word_idx ON public.sentence_attempts (word_id);
GRANT SELECT, INSERT, DELETE ON public.sentence_attempts TO authenticated;
GRANT ALL ON public.sentence_attempts TO service_role;
ALTER TABLE public.sentence_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own sentence attempts" ON public.sentence_attempts FOR ALL TO authenticated USING (device_id = (auth.uid())::text) WITH CHECK (device_id = (auth.uid())::text);

-- review_sessions
CREATE TABLE public.review_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text NOT NULL DEFAULT (auth.uid())::text,
  set_id uuid NOT NULL REFERENCES public.word_sets(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('words','forms')),
  purpose text NOT NULL CHECK (purpose IN ('initial','review')),
  status text NOT NULL DEFAULT 'active',
  phase text NOT NULL DEFAULT 'units',
  position integer NOT NULL DEFAULT 0,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_for timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  recall text,
  timing text,
  accuracy numeric,
  correct_count integer,
  incorrect_count integer,
  delay_days numeric,
  stage_before integer,
  stage_after integer,
  interval_days integer,
  next_review_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX review_sessions_one_active ON public.review_sessions (set_id, kind) WHERE status = 'active';
CREATE INDEX review_sessions_history_idx ON public.review_sessions (set_id, kind, completed_at);
CREATE INDEX review_sessions_device_idx ON public.review_sessions (device_id, status);
GRANT SELECT, INSERT, UPDATE ON public.review_sessions TO authenticated;
GRANT ALL ON public.review_sessions TO service_role;
ALTER TABLE public.review_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own reviews read" ON public.review_sessions FOR SELECT TO authenticated USING (device_id = (auth.uid())::text);
CREATE POLICY "own reviews insert" ON public.review_sessions FOR INSERT TO authenticated WITH CHECK (device_id = (auth.uid())::text AND public.owns_set(set_id));
CREATE POLICY "own reviews update" ON public.review_sessions FOR UPDATE TO authenticated USING (device_id = (auth.uid())::text AND status = 'active') WITH CHECK (device_id = (auth.uid())::text);
CREATE TRIGGER review_sessions_touch BEFORE UPDATE ON public.review_sessions FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- training_sessions (set_id SET NULL: earned points are permanent)
CREATE TABLE public.training_sessions (
  id uuid PRIMARY KEY,
  device_id text NOT NULL DEFAULT (auth.uid())::text,
  set_id uuid REFERENCES public.word_sets(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'words',
  scope text NOT NULL DEFAULT 'set' CHECK (scope IN ('set','single')),
  target_language text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  local_day date,
  duration_seconds integer,
  total_attempts integer,
  correct_attempts integer,
  incorrect_attempts integer,
  corrected_attempts integer,
  accuracy numeric,
  points integer NOT NULL DEFAULT 0
);
CREATE INDEX training_sessions_device_idx ON public.training_sessions (device_id, target_language, status, local_day);
GRANT SELECT, INSERT ON public.training_sessions TO authenticated;
GRANT ALL ON public.training_sessions TO service_role;
ALTER TABLE public.training_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own training read" ON public.training_sessions FOR SELECT TO authenticated USING (device_id = (auth.uid())::text);
CREATE POLICY "own training insert" ON public.training_sessions FOR INSERT TO authenticated
  WITH CHECK (device_id = (auth.uid())::text AND (set_id IS NULL OR public.owns_set(set_id)));

-- daily progress
CREATE TABLE public.daily_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text NOT NULL DEFAULT (auth.uid())::text,
  day date NOT NULL DEFAULT current_date,
  goal_minutes integer NOT NULL DEFAULT 10,
  minutes_practiced numeric NOT NULL DEFAULT 0,
  items_completed integer NOT NULL DEFAULT 0,
  UNIQUE (device_id, day)
);
GRANT SELECT, INSERT, UPDATE ON public.daily_progress TO authenticated;
GRANT ALL ON public.daily_progress TO service_role;
ALTER TABLE public.daily_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own daily" ON public.daily_progress FOR ALL TO authenticated USING (device_id = (auth.uid())::text) WITH CHECK (device_id = (auth.uid())::text);

CREATE TABLE public.language_daily_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text NOT NULL DEFAULT (auth.uid())::text,
  target_language text NOT NULL,
  day date NOT NULL DEFAULT current_date,
  goal_minutes integer NOT NULL DEFAULT 10,
  minutes_practiced numeric NOT NULL DEFAULT 0,
  items_completed integer NOT NULL DEFAULT 0,
  UNIQUE (device_id, day, target_language)
);
GRANT SELECT, INSERT, UPDATE ON public.language_daily_progress TO authenticated;
GRANT ALL ON public.language_daily_progress TO service_role;
ALTER TABLE public.language_daily_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own language daily" ON public.language_daily_progress FOR ALL TO authenticated USING (device_id = (auth.uid())::text) WITH CHECK (device_id = (auth.uid())::text);

-- audio cache (server only)
CREATE TABLE public.audio_assets (
  cache_key text PRIMARY KEY,
  text text NOT NULL,
  language text NOT NULL,
  voice text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  storage_path text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.audio_assets TO service_role;
ALTER TABLE public.audio_assets ENABLE ROW LEVEL SECURITY;

-- Schedules and results can only be written by the database functions below.
CREATE OR REPLACE FUNCTION public.guard_set_schedule() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF coalesce(current_setting('lingoflow.schedule_write', true), '') = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.review_stage := 0; NEW.last_reviewed_at := NULL; NEW.next_review_at := NULL;
    NEW.forms_review_stage := 0; NEW.forms_last_reviewed_at := NULL; NEW.forms_next_review_at := NULL;
  ELSE
    NEW.review_stage := OLD.review_stage; NEW.last_reviewed_at := OLD.last_reviewed_at; NEW.next_review_at := OLD.next_review_at;
    NEW.forms_review_stage := OLD.forms_review_stage; NEW.forms_last_reviewed_at := OLD.forms_last_reviewed_at; NEW.forms_next_review_at := OLD.forms_next_review_at;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER word_sets_guard_schedule BEFORE INSERT OR UPDATE ON public.word_sets FOR EACH ROW EXECUTE FUNCTION public.guard_set_schedule();

CREATE OR REPLACE FUNCTION public.guard_review_session() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF coalesce(current_setting('lingoflow.schedule_write', true), '') = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'active'; NEW.completed_at := NULL; NEW.recall := NULL; NEW.timing := NULL; NEW.accuracy := NULL;
    NEW.correct_count := NULL; NEW.incorrect_count := NULL; NEW.delay_days := NULL; NEW.stage_before := NULL;
    NEW.stage_after := NULL; NEW.interval_days := NULL; NEW.next_review_at := NULL; NEW.started_at := now();
  ELSE
    NEW.status := OLD.status; NEW.completed_at := OLD.completed_at; NEW.recall := OLD.recall; NEW.timing := OLD.timing;
    NEW.accuracy := OLD.accuracy; NEW.correct_count := OLD.correct_count; NEW.incorrect_count := OLD.incorrect_count;
    NEW.delay_days := OLD.delay_days; NEW.stage_before := OLD.stage_before; NEW.stage_after := OLD.stage_after;
    NEW.interval_days := OLD.interval_days; NEW.next_review_at := OLD.next_review_at; NEW.started_at := OLD.started_at;
    NEW.scheduled_for := OLD.scheduled_for; NEW.set_id := OLD.set_id; NEW.kind := OLD.kind; NEW.purpose := OLD.purpose;
    NEW.device_id := OLD.device_id;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER review_sessions_guard BEFORE INSERT OR UPDATE ON public.review_sessions FOR EACH ROW EXECUTE FUNCTION public.guard_review_session();

CREATE OR REPLACE FUNCTION public.guard_training_session() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF coalesce(current_setting('lingoflow.schedule_write', true), '') = 'on' THEN RETURN NEW; END IF;
  NEW.status := 'active'; NEW.completed_at := NULL; NEW.points := 0; NEW.accuracy := NULL;
  NEW.total_attempts := NULL; NEW.correct_attempts := NULL; NEW.incorrect_attempts := NULL;
  NEW.corrected_attempts := NULL; NEW.duration_seconds := NULL; NEW.local_day := NULL;
  RETURN NEW;
END; $$;
CREATE TRIGGER training_sessions_guard BEFORE INSERT ON public.training_sessions FOR EACH ROW EXECUTE FUNCTION public.guard_training_session();

-- Review ladder: 3/7/14/30/60/120/180/270/365 days
CREATE OR REPLACE FUNCTION public.review_interval_days(_stage integer) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _stage <= 1 THEN 3 WHEN _stage = 2 THEN 7 WHEN _stage = 3 THEN 14 WHEN _stage = 4 THEN 30
    WHEN _stage = 5 THEN 60 WHEN _stage = 6 THEN 120 WHEN _stage = 7 THEN 180 WHEN _stage = 8 THEN 270
    ELSE 365 END
$$;

/*
 Grades a review from the first attempt per item of graded answers
 (recognition excluded) made since the session started:
   strong >= 85%, moderate >= 60%, else poor.
 Timing: initial | on_time (<= 1 day late) | late | long_delay (late by at
 least max(7 days, current interval)).
 Normal: strong advances one stage, moderate repeats the stage, poor drops one
 stage; a second poor review in a row returns to stage 1.
 Long delay never advances: strong/moderate keep the stage with a shorter
 recovery interval (half the stage interval, min 3; moderate 3 days), then the
 next on-time review continues the normal ladder. Poor follows the poor rules.
 Next review = completion time + interval. Mastery is never changed by time.
*/
CREATE OR REPLACE FUNCTION public.complete_review_session(_session_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s public.review_sessions;
  ws public.word_sets;
  v_correct integer; v_incorrect integer; v_total integer;
  v_accuracy numeric; v_recall text; v_timing text;
  v_stage_before integer; v_stage_after integer; v_interval integer;
  v_prev_next timestamptz; v_delay numeric; v_prev_recall text; v_next timestamptz;
BEGIN
  SELECT * INTO s FROM public.review_sessions WHERE id = _session_id AND device_id = (auth.uid())::text FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Review session not found'; END IF;
  IF s.status = 'completed' THEN
    RETURN jsonb_build_object('advanced', false, 'already', true, 'recall', s.recall, 'accuracy', s.accuracy,
      'timing', s.timing, 'stage', s.stage_after, 'stage_before', s.stage_before, 'interval_days', s.interval_days,
      'next_review_at', s.next_review_at, 'correct', s.correct_count, 'incorrect', s.incorrect_count);
  END IF;
  SELECT * INTO ws FROM public.word_sets WHERE id = s.set_id FOR UPDATE;

  WITH firsts AS (
    SELECT DISTINCT ON (pa.learning_item_id) pa.is_correct
    FROM public.practice_attempts pa JOIN public.learning_items li ON li.id = pa.learning_item_id
    WHERE li.set_id = s.set_id AND pa.device_id = s.device_id AND pa.skill <> 'recognition'
      AND pa.created_at >= s.started_at
      AND ((s.kind = 'words' AND li.form_id IS NULL) OR (s.kind = 'forms' AND li.form_id IS NOT NULL))
    ORDER BY pa.learning_item_id, pa.created_at
  )
  SELECT count(*) FILTER (WHERE is_correct), count(*) FILTER (WHERE NOT is_correct) INTO v_correct, v_incorrect FROM firsts;
  v_total := v_correct + v_incorrect;
  v_accuracy := CASE WHEN v_total > 0 THEN round(100.0 * v_correct / v_total, 1) ELSE NULL END;
  v_recall := CASE WHEN v_accuracy IS NULL THEN 'moderate' WHEN v_accuracy >= 85 THEN 'strong' WHEN v_accuracy >= 60 THEN 'moderate' ELSE 'poor' END;

  IF s.kind = 'words' THEN v_stage_before := ws.review_stage; v_prev_next := ws.next_review_at;
  ELSE v_stage_before := ws.forms_review_stage; v_prev_next := ws.forms_next_review_at; END IF;

  SELECT recall INTO v_prev_recall FROM public.review_sessions
   WHERE set_id = s.set_id AND kind = s.kind AND status = 'completed' AND purpose = 'review'
   ORDER BY completed_at DESC LIMIT 1;

  IF s.purpose = 'initial' OR v_stage_before = 0 THEN
    v_timing := 'initial'; v_delay := 0; v_stage_after := 1; v_interval := public.review_interval_days(1);
  ELSE
    v_delay := greatest(0, extract(epoch FROM (now() - coalesce(s.scheduled_for, v_prev_next, now()))) / 86400.0);
    v_delay := round(v_delay, 2);
    IF v_delay <= 1 THEN v_timing := 'on_time';
    ELSIF v_delay >= greatest(7, public.review_interval_days(v_stage_before)) THEN v_timing := 'long_delay';
    ELSE v_timing := 'late'; END IF;

    IF v_recall = 'poor' THEN
      v_stage_after := CASE WHEN v_prev_recall = 'poor' THEN 1 ELSE greatest(1, v_stage_before - 1) END;
      v_interval := public.review_interval_days(v_stage_after);
    ELSIF v_timing = 'long_delay' THEN
      v_stage_after := v_stage_before;
      v_interval := CASE WHEN v_recall = 'strong'
        THEN greatest(3, ceil(public.review_interval_days(v_stage_before) / 2.0)::integer) ELSE 3 END;
    ELSIF v_recall = 'strong' THEN
      v_stage_after := v_stage_before + 1; v_interval := public.review_interval_days(v_stage_after);
    ELSE
      v_stage_after := v_stage_before; v_interval := public.review_interval_days(v_stage_after);
    END IF;
  END IF;
  v_next := now() + make_interval(days => v_interval);

  PERFORM set_config('lingoflow.schedule_write', 'on', true);
  IF s.kind = 'words' THEN
    UPDATE public.word_sets SET review_stage = v_stage_after, last_reviewed_at = now(), next_review_at = v_next WHERE id = s.set_id;
  ELSE
    UPDATE public.word_sets SET forms_review_stage = v_stage_after, forms_last_reviewed_at = now(), forms_next_review_at = v_next WHERE id = s.set_id;
  END IF;
  UPDATE public.review_sessions SET status = 'completed', completed_at = now(), recall = v_recall, timing = v_timing,
    accuracy = v_accuracy, correct_count = v_correct, incorrect_count = v_incorrect, delay_days = v_delay,
    stage_before = v_stage_before, stage_after = v_stage_after, interval_days = v_interval, next_review_at = v_next
   WHERE id = s.id;
  PERFORM set_config('lingoflow.schedule_write', 'off', true);

  RETURN jsonb_build_object('advanced', v_stage_after > v_stage_before, 'recall', v_recall, 'accuracy', v_accuracy,
    'timing', v_timing, 'stage', v_stage_after, 'stage_before', v_stage_before, 'interval_days', v_interval,
    'next_review_at', v_next, 'correct', v_correct, 'incorrect', v_incorrect);
END; $$;

/*
 Completes a training session once from its real answers: first attempt per
 item (recognition excluded); corrected = first wrong, later right in the same
 session; points = round(accuracy/100 x max), max 15 (set) or 5 (single).
*/
CREATE OR REPLACE FUNCTION public.complete_training_session(_session_id uuid, _local_day date, _active_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t public.training_sessions;
  v_total integer; v_correct integer; v_incorrect integer; v_corrected integer;
  v_accuracy numeric; v_points integer; v_max integer;
BEGIN
  SELECT * INTO t FROM public.training_sessions WHERE id = _session_id AND device_id = (auth.uid())::text FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Training session not found'; END IF;
  IF t.status <> 'completed' THEN
    WITH a AS (
      SELECT learning_item_id, is_correct, row_number() OVER (PARTITION BY learning_item_id ORDER BY created_at) AS rn
      FROM public.practice_attempts
      WHERE training_session_id = _session_id AND device_id = t.device_id AND skill <> 'recognition'
    ), per AS (
      SELECT learning_item_id, bool_or(is_correct) FILTER (WHERE rn = 1) AS first_ok, bool_or(is_correct) AS any_ok FROM a GROUP BY learning_item_id
    )
    SELECT count(*), count(*) FILTER (WHERE first_ok), count(*) FILTER (WHERE NOT first_ok),
           count(*) FILTER (WHERE NOT first_ok AND any_ok)
      INTO v_total, v_correct, v_incorrect, v_corrected FROM per;
    v_accuracy := CASE WHEN v_total > 0 THEN round(100.0 * v_correct / v_total, 1) ELSE NULL END;
    v_max := CASE WHEN t.scope = 'single' THEN 5 ELSE 15 END;
    v_points := CASE WHEN v_accuracy IS NULL THEN 0 ELSE round(v_accuracy / 100.0 * v_max)::integer END;
    PERFORM set_config('lingoflow.schedule_write', 'on', true);
    UPDATE public.training_sessions SET status = 'completed', completed_at = now(), local_day = _local_day,
      duration_seconds = greatest(0, coalesce(_active_seconds, 0)), total_attempts = v_total, correct_attempts = v_correct,
      incorrect_attempts = v_incorrect, corrected_attempts = v_corrected, accuracy = v_accuracy, points = v_points
     WHERE id = _session_id RETURNING * INTO t;
    PERFORM set_config('lingoflow.schedule_write', 'off', true);
  END IF;
  RETURN jsonb_build_object('id', t.id, 'duration_seconds', t.duration_seconds, 'total', t.total_attempts,
    'correct', t.correct_attempts, 'incorrect', t.incorrect_attempts, 'corrected', t.corrected_attempts,
    'accuracy', t.accuracy, 'points', t.points, 'scope', t.scope);
END; $$;

REVOKE ALL ON FUNCTION public.complete_review_session(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_training_session(uuid, date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_review_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_training_session(uuid, date, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.owns_set(uuid), public.owns_word(uuid), public.review_interval_days(integer) TO authenticated;

-- Profile + learner rows on sign-up
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (NEW.id, NEW.email, coalesce(NEW.raw_user_meta_data->>'display_name', NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'))
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.learners (device_id, display_name)
  VALUES (NEW.id::text, coalesce(NEW.raw_user_meta_data->>'display_name', NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', ''))
  ON CONFLICT (device_id) DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Storage policies: avatars are private per user folder; speech audio is server-only
CREATE POLICY "avatars own read" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (auth.uid())::text);
CREATE POLICY "avatars own insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (auth.uid())::text);
CREATE POLICY "avatars own update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (auth.uid())::text);
CREATE POLICY "avatars own delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (auth.uid())::text);