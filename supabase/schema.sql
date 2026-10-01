-- MOTEL CASHLESS - Esquema Supabase. Pegar en SQL Editor y ejecutar (idempotente).
create or replace function public.touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end; $$ language plpgsql;
do $$
declare t text;
begin
foreach t in array array['rooms','objects','products','staff','reservations','accounts','invoices','cleanlogs','attendance','clients','settings','waiting'] loop
execute format('create table if not exists public.%I (id text primary key, data jsonb not null default ''{}''::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now())', t);
execute format('drop trigger if exists trg_touch on public.%I', t);
execute format('create trigger trg_touch before update on public.%I for each row execute function public.touch_updated_at()', t);
execute format('alter table public.%I enable row level security', t);
execute format('drop policy if exists "motel_all" on public.%I', t);
execute format('create policy "motel_all" on public.%I for all to anon, authenticated using (true) with check (true)', t);
execute format('grant select, insert, update, delete on public.%I to anon, authenticated', t);
end loop;
end $$;
create index if not exists idx_res_code on public.reservations ((data->>'code'));
create index if not exists idx_staff_ced on public.staff ((data->>'cedula'));
create index if not exists idx_att_staff on public.attendance ((data->>'staffId'));
