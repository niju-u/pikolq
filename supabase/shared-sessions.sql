-- =====================================================================
-- Pickleball Open Play: shareable sessions (Supabase)
--
-- Run this once in your Supabase project: Dashboard > SQL Editor > New query,
-- paste this whole file, then Run. It is safe to run again.
--
-- How it works
--   * Each shared session has a 6-character code (for watching) and a passcode
--     (for editing). Only a hash of the passcode is stored.
--   * The table is not readable or writable directly: the website can only call
--     the functions below, which check the code, the passcode and the expiry.
--   * A shared session is deleted 24 hours after its last change. Expired sessions
--     are hidden right away, and removed by an hourly clean-up job (pg_cron) and
--     whenever someone shares a new session.
--   * After 8 wrong passcodes in a row a session locks editing for 15 minutes.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.shared_sessions (
  code            text primary key,
  state           jsonb not null,
  pass_hash       text not null,
  version         bigint not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '24 hours',
  failed_attempts integer not null default 0,
  locked_until    timestamptz
);

-- Nobody reads or writes the table directly; only the functions below (security definer) do.
alter table public.shared_sessions enable row level security;
revoke all on public.shared_sessions from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.shared_sessions from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.shared_sessions from authenticated';
  end if;
end $$;

create index if not exists shared_sessions_expires_at on public.shared_sessions (expires_at);

-- ---------------------------------------------------------------------
-- Helpers (not callable from the website)
-- ---------------------------------------------------------------------

-- A random 6-character code without look-alike characters (no 0/O, 1/I/L)
create or replace function public.share_new_code()
returns text
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  bytes bytea := gen_random_bytes(6);
  result text := '';
begin
  for i in 0..5 loop
    result := result || substr(alphabet, (get_byte(bytes, i) % length(alphabet)) + 1, 1);
  end loop;
  return result;
end $$;

-- Checks the passcode for an (already locked) row and keeps the wrong-attempt count.
-- Returns 'ok', 'locked' or 'denied'.
create or replace function public.share_check(p_row public.shared_sessions, p_pass text)
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
begin
  if p_row.locked_until is not null and p_row.locked_until > now() then
    return 'locked';
  end if;
  if p_pass is null or crypt(p_pass, p_row.pass_hash) <> p_row.pass_hash then
    update public.shared_sessions
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 8 then now() + interval '15 minutes' else locked_until end
     where code = p_row.code;
    return 'denied';
  end if;
  if p_row.failed_attempts <> 0 or p_row.locked_until is not null then
    update public.shared_sessions set failed_attempts = 0, locked_until = null where code = p_row.code;
  end if;
  return 'ok';
end $$;

-- ---------------------------------------------------------------------
-- Functions the website calls (POST /rest/v1/rpc/<name>)
-- ---------------------------------------------------------------------

-- Share a session: stores it and returns its new code.
create or replace function public.share_session(p_state jsonb, p_pass text)
returns json
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  new_code text;
  row public.shared_sessions;
begin
  if p_pass is null or length(p_pass) < 4 or length(p_pass) > 32 then
    return json_build_object('error', 'bad_passcode');
  end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' or octet_length(p_state::text) > 1000000 then
    return json_build_object('error', 'bad_state');
  end if;

  delete from public.shared_sessions where expires_at < now(); -- tidy up while we're here

  loop
    new_code := share_new_code();
    begin
      insert into public.shared_sessions (code, state, pass_hash)
      values (new_code, p_state, crypt(p_pass, gen_salt('bf', 8)))
      returning * into row;
      exit;
    exception when unique_violation then
      -- extremely rare: try another code
    end;
  end loop;

  return json_build_object('code', row.code, 'version', row.version, 'expires_at', row.expires_at);
end $$;

-- Read a shared session (no passcode needed: the code alone lets you watch).
-- p_since: the version you already have; if nothing changed, the state is left out.
create or replace function public.get_shared_session(p_code text, p_since bigint default 0)
returns json
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  row public.shared_sessions;
begin
  select * into row from public.shared_sessions
   where code = upper(trim(p_code)) and expires_at > now();
  if not found then
    return json_build_object('missing', true);
  end if;
  if row.version <= coalesce(p_since, 0) then
    return json_build_object('version', row.version, 'expires_at', row.expires_at, 'unchanged', true);
  end if;
  return json_build_object('state', row.state, 'version', row.version, 'expires_at', row.expires_at);
end $$;

-- Check a passcode (to switch a watcher to editing).
create or replace function public.check_share_passcode(p_code text, p_pass text)
returns json
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  row public.shared_sessions;
  result text;
begin
  select * into row from public.shared_sessions
   where code = upper(trim(p_code)) and expires_at > now()
   for update;
  if not found then
    return json_build_object('missing', true);
  end if;
  result := share_check(row, p_pass);
  if result = 'locked' then return json_build_object('locked', true, 'locked_until', row.locked_until); end if;
  if result = 'denied' then return json_build_object('denied', true); end if;
  return json_build_object('ok', true, 'state', row.state, 'version', row.version, 'expires_at', row.expires_at);
end $$;

-- Save a change. p_base_version is the version the change was made on: if someone else
-- saved in between, nothing is saved and the newer copy is returned ('conflict').
-- Every saved change pushes the deletion time back to 24 hours from now.
create or replace function public.update_shared_session(p_code text, p_pass text, p_state jsonb, p_base_version bigint)
returns json
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  row public.shared_sessions;
  result text;
begin
  select * into row from public.shared_sessions
   where code = upper(trim(p_code)) and expires_at > now()
   for update;
  if not found then
    return json_build_object('missing', true);
  end if;
  result := share_check(row, p_pass);
  if result = 'locked' then return json_build_object('locked', true, 'locked_until', row.locked_until); end if;
  if result = 'denied' then return json_build_object('denied', true); end if;
  if p_state is null or jsonb_typeof(p_state) <> 'object' or octet_length(p_state::text) > 1000000 then
    return json_build_object('error', 'bad_state');
  end if;
  if row.version <> p_base_version then
    return json_build_object('conflict', true, 'state', row.state, 'version', row.version, 'expires_at', row.expires_at);
  end if;

  update public.shared_sessions
     set state = p_state,
         version = version + 1,
         updated_at = now(),
         expires_at = now() + interval '24 hours'
   where code = row.code
  returning * into row;
  return json_build_object('version', row.version, 'expires_at', row.expires_at);
end $$;

-- Stop sharing: deletes the shared copy now (needs the passcode).
create or replace function public.stop_sharing_session(p_code text, p_pass text)
returns json
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  row public.shared_sessions;
  result text;
begin
  select * into row from public.shared_sessions
   where code = upper(trim(p_code)) and expires_at > now()
   for update;
  if not found then
    return json_build_object('missing', true);
  end if;
  result := share_check(row, p_pass);
  if result = 'locked' then return json_build_object('locked', true, 'locked_until', row.locked_until); end if;
  if result = 'denied' then return json_build_object('denied', true); end if;
  delete from public.shared_sessions where code = row.code;
  return json_build_object('ok', true);
end $$;

-- Only the five website functions can be called; the helpers stay private.
revoke all on function public.share_new_code() from public;
revoke all on function public.share_check(public.shared_sessions, text) from public;
revoke all on function public.share_session(jsonb, text) from public;
revoke all on function public.get_shared_session(text, bigint) from public;
revoke all on function public.check_share_passcode(text, text) from public;
revoke all on function public.update_shared_session(text, text, jsonb, bigint) from public;
revoke all on function public.stop_sharing_session(text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.share_new_code() from anon, authenticated';
    execute 'revoke all on function public.share_check(public.shared_sessions, text) from anon, authenticated';
    execute 'grant execute on function public.share_session(jsonb, text) to anon, authenticated';
    execute 'grant execute on function public.get_shared_session(text, bigint) to anon, authenticated';
    execute 'grant execute on function public.check_share_passcode(text, text) to anon, authenticated';
    execute 'grant execute on function public.update_shared_session(text, text, jsonb, bigint) to anon, authenticated';
    execute 'grant execute on function public.stop_sharing_session(text, text) to anon, authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Hourly clean-up of expired sessions (pg_cron). If this part fails, enable
-- "pg_cron" under Database > Extensions and run the file again. Expired
-- sessions are hidden either way.
-- ---------------------------------------------------------------------
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'delete-expired-shared-sessions';
  perform cron.schedule('delete-expired-shared-sessions', '17 * * * *',
    $job$delete from public.shared_sessions where expires_at < now()$job$);
exception when others then
  raise notice 'Hourly clean-up not scheduled (enable pg_cron under Database > Extensions, then run this file again): %', sqlerrm;
end $$;
