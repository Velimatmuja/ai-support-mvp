-- Imitim minimal i një projekti Supabase për të testuar migrimin në një Postgres
-- të zakonshëm PA pgvector. Vetëm për test lokal; mos e ekzekuto në Supabase.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$;
grant usage on schema auth to anon, authenticated, service_role;

-- "vector" i rremë: tekst '[1,0,...]' + distanca kosinus në SQL.
create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create domain extensions.vector as text;
create function extensions.cosine_distance(a text, b text) returns double precision
language sql immutable as $$
  select 1 - sum(x * y) / nullif(sqrt(sum(x * x)) * sqrt(sum(y * y)), 0)
  from unnest(
    string_to_array(trim(both '[]' from a), ',')::float8[],
    string_to_array(trim(both '[]' from b), ',')::float8[]
  ) as t(x, y);
$$;
create operator extensions.<=> (
  leftarg = text, rightarg = text, function = extensions.cosine_distance
);
