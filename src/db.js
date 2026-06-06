create table if not exists pl_ledger (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references pl_profiles(id) on delete cascade,
  kind text not null check (kind in ('charge','payment')),
  description text not null default '',
  amount numeric(12,2) not null default 0,
  method text not null default '',
  date date not null default current_date,
  recorded_by uuid references pl_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table pl_ledger enable row level security;
drop policy if exists "pl_ledger_read" on pl_ledger;
drop policy if exists "pl_ledger_write" on pl_ledger;
create policy "pl_ledger_read" on pl_ledger for select to authenticated using (student_id = auth.uid() or pl_is_instructor());
create policy "pl_ledger_write" on pl_ledger for all to authenticated using (pl_is_instructor()) with check (pl_is_instructor());
