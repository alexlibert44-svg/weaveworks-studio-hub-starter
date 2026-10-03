# Move LingoFlow to Lovable Cloud (no app rebuild)

All app code, screens and learning logic stay as they are. Only the backend the app points to changes. Nothing in the old database is touched or deleted.

## Important finding first

The project contains the *shape* of the old database (tables, columns, function names), but **not the code inside its database functions and triggers**. Those include `complete_review_session`, which runs the review scheduling and long-delay recovery. There are two ways to get them back:

- **Best:** the old owner exports the database structure (Supabase dashboard -> Database -> Backups, or `pg_dump --schema-only`) and sends you the file. I recreate everything exactly from it. If they also export the data, users and progress can be imported too.
- **Fallback:** I rebuild those functions from the rules written in the project's notes and from how the app uses them. Those rules are: the accuracy thresholds, the 3/7/14/30/60/120/180/270/365-day ladder, long delays never advancing a stage, and two poor reviews in a row resetting to stage 1. The behavior matches the documented rules, but it may differ in small details the notes don't cover.

I won't start until you choose one of these.

## Existing tables (recreated with the same columns and links)

| Table | Purpose |
|---|---|
| profiles | Account name and email, one per user |
| learners | Settings: native/learning language, daily goal, streaks, avatar, onboarding |
| word_sets | Word groups plus their review schedule (stage, last/next review, Forms schedule) |
| words | Words with AI analysis, meaning, part of speech, meaning options |
| word_forms | Tenses and derived forms per word |
| sentences | Example sentences, translations, word hints/glosses |
| learning_items | Per-item, per-skill progress (writing, pronunciation, meaning): mastery, streak, attempts, mistakes |
| practice_attempts | Each correct/incorrect answer |
| pronunciation_attempts | Pronunciation results (matched/missed words, score) |
| sentence_attempts | Sentence writing and AI corrections |
| review_sessions | Review history: stage before/after, delay, accuracy, timing, next review |
| training_sessions | Completed sessions, points, accuracy |
| daily_progress / language_daily_progress | Daily minutes and goal, overall and per language |
| audio_assets | Saved audio files, so audio is never generated twice |

There are also two status lists: mastery levels (new to mastered) and skill types.

## Database functions and triggers to recreate

- `complete_review_session`: accuracy and timing grading, stage ladder, late/long-delay recovery, next review date
- `complete_training_session`: points, accuracy, streaks (runs once per session only)
- `review_interval_days`: days for each stage
- `owns_set`, `owns_word`: ownership checks used by the security rules
- Triggers that stop the app from writing schedules directly (only the review function may write them)
- A trigger that creates the profile and settings when someone signs up
- Indexes for each user's lookups and due reviews

## Security rules

- Every user table: each person can read and change only their own rows (`device_id = auth.uid()`).
- Words, forms and sentences: allowed only through ownership of their word set.
- Completed training sessions keep their points even when a word set is deleted.

## Storage

- `avatars`: private, files in `<user id>/...`, accessed through temporary links
- `speech-audio`: private, read and written only by the server for cached audio

## Sign-in setup

- Email and password, with a confirmation email; password reset through the existing reset page
- Google through Lovable Cloud's managed Google sign-in, so you don't need your own Google setup
- Sessions stay saved and renew automatically, using the app's existing token-renewal code
- AI features keep working through the built-in AI service

## Technical details

- Enable Lovable Cloud. This replaces the backend address and keys in `.env` with the new project's.
- One migration creates the types, the tables (with GRANTs), RLS, functions, triggers, indexes and buckets. A second migration, only if an export is supplied, imports the data and users.
- Remove the duplicate `attachSupabaseAuth` from `src/start.ts` and keep the project's own renewing middleware. This avoids two competing ways of attaching sign-in tokens.
- No changes to app logic, screens, or the review algorithm code on the app side.

## Tests I will run and report honestly

1. Sign up, confirm, sign in, sign out, sign in again
2. Stay signed in after a refresh and after reopening
3. Wrong password, duplicate email and no-connection messages; no endless loading
4. Password reset email request
5. Create a word group: AI analysis, forms, sentences, audio saved, then reused
6. Training: points, wrong-answer repetition, per-skill progress saved
7. Review: correct stage and next date; a long-delay review gives a shorter recovery interval
8. A second account cannot see or change the first account's data

Google sign-in can only be fully tested by you clicking it in the preview, because it needs a real Google account.
