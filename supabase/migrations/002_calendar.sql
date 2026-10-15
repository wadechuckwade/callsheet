-- Calendar links: a private subscription link per person, so Apple Calendar,
-- Google Calendar or Outlook can show their Callsheet sessions, events and deadlines.
-- Safe to run more than once.

create table if not exists public.cal_feeds (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  token       text not null unique,
  tz          text not null default 'Europe/London',
  created_at  timestamptz not null default now()
);
alter table public.cal_feeds enable row level security;
-- No policies: nobody reads this table directly. The functions below do the work.

create or replace function public.new_feed_token() returns text
language sql volatile as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
$$;

-- Returns your private feed token, creating it the first time.
-- reset = true makes a new one, so the old link stops working.
create or replace function public.calendar_feed(reset boolean default false, tz text default null)
returns text language plpgsql volatile security definer set search_path = public as $$
declare t text; me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in'; end if;
  insert into public.cal_feeds(user_id, token, tz) values (me, public.new_feed_token(), coalesce(nullif(tz, ''), 'Europe/London'))
    on conflict (user_id) do nothing;
  if reset then update public.cal_feeds set token = public.new_feed_token() where user_id = me; end if;
  if tz is not null and tz <> '' then update public.cal_feeds set tz = calendar_feed.tz where user_id = me; end if;
  select token into t from public.cal_feeds where user_id = me;
  return t;
end $$;

-- What the feed shows, looked up by the secret token (used by the calendar server function).
-- Only that person's booked sessions, their own events and the deadlines they follow.
create or replace function public.calendar_feed_items(feed_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when f.user_id is null then null else jsonb_build_object(
    'tz', f.tz,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('col', r.col, 'id', r.id, 'data', r.data, 'updated', r.updated_at))
      from public.records r
      where r.owner = f.user_id
        and (
          (r.col = 'sessions' and coalesce(r.data->>'status', '') <> 'suggested')
          or (r.col = 'events' and coalesce(r.data->>'source', '') not in ('deputy', 'apple', 'ics'))
          or (r.col = 'deadlines' and coalesce((r.data->>'followed')::boolean, false))
        )
    ), '[]'::jsonb)) end
  from (select 1) one left join public.cal_feeds f on f.token = feed_token and length(feed_token) >= 40
$$;

revoke all on function public.calendar_feed_items(text) from public;
grant execute on function public.calendar_feed_items(text) to anon, authenticated;
grant execute on function public.calendar_feed(boolean, text) to authenticated;
