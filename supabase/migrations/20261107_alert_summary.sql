-- Tomo's longer "quick summary", shown when an alert is clicked open.
-- `body` stays the one-line preview in the list; `summary` is the expanded view.
alter table public.alerts
  add column if not exists summary text check (summary is null or char_length(summary) <= 6000);

notify pgrst, 'reload schema';
