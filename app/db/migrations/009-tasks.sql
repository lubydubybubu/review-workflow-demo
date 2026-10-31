-- 009: standalone tasks (할 일), optionally linked to a review. Additive: no existing table changes.
--
-- Status is the category of the task's stage. Tasks reuse the shared stage model (001: entity_type
-- 'task' was reserved for this) with one fixed stage per category; the settings screen only manages
-- review stages, so these three are not user-editable. The composite FK pins a task to stages of its
-- own entity type, exactly like reviews (a task can never sit in a review stage, nor a review in a task stage).
--
-- Date rule: `due_on` is a date-only fact interpreted in Asia/Seoul (same as review deadlines).
-- `version` is the compare-and-set token for every task writer, bumped by a trigger on every update.
-- `completed_at` is owned by the database: set when the stage enters 완료, cleared when it leaves.
-- Tasks are never hard-deleted by the app: archive instead (`archived_at`).
--
-- Review link policy: a task may be linked to an active review only. Linking (insert, or changing
-- review_id) to an archived review is refused by a trigger; a task that was linked before the review
-- was archived keeps its link (shown as 보관된 리뷰) and stays fully editable. Archiving a review never
-- touches its tasks, and nothing here writes to `reviews` (so an open review form's version is unaffected).

insert into workflow_stages (entity_type, category_key, name, color, sort, is_default) values
  ('task', 'todo',        '할 일',  '#8A8A8A', 1, true),
  ('task', 'in_progress', '진행 중', '#4C7DD9', 1, false),
  ('task', 'done',        '완료',   '#2F9E6E', 1, false);

create table tasks (
  id           bigint generated always as identity primary key,
  -- one line: no C0 control characters / DEL (NUL cannot be stored in text at all)
  title        text not null check (btrim(title) <> '' and char_length(title) <= 200
                                    and title !~ '[\x01-\x1f\x7f]'),
  stage_id     bigint not null,
  stage_entity text not null default 'task' check (stage_entity = 'task'),
  priority     text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  due_on       date check (due_on between '2000-01-01' and '2099-12-31'),
  review_id    bigint references reviews (id) on delete restrict,
  -- markdown: tab / newline / carriage return allowed, other control characters are not
  memo_md      text not null default '' check (char_length(memo_md) <= 20000
                                               and memo_md !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  completed_at timestamptz,
  archived_at  timestamptz,
  version      integer not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (stage_id, stage_entity) references workflow_stages (id, entity_type)
);

create index tasks_due_on_idx on tasks (due_on) where archived_at is null and due_on is not null;
create index tasks_stage_idx on tasks (stage_id) where archived_at is null;
create index tasks_review_idx on tasks (review_id) where review_id is not null;

create trigger tasks_set_updated_at before update on tasks
  for each row execute function set_updated_at();

create function bump_task_version() returns trigger
language plpgsql as $$
begin
  new.version := old.version + 1;
  return new;
end;
$$;

create trigger tasks_bump_version before update on tasks
  for each row execute function bump_task_version();

create function sync_task_completed_at() returns trigger
language plpgsql as $$
declare
  category text;
begin
  select category_key into category from workflow_stages where id = new.stage_id;
  if category = 'done' then
    new.completed_at := case when tg_op = 'UPDATE' then coalesce(old.completed_at, now()) else now() end;
  else
    new.completed_at := null;
  end if;
  return new;
end;
$$;

create trigger tasks_sync_completed_at before insert or update on tasks
  for each row execute function sync_task_completed_at();

-- The row lock (FOR SHARE) makes a concurrent review archive wait for this insert/update to commit,
-- so "link to an active review" cannot race with "archive the review".
create function check_task_review_link() returns trigger
language plpgsql as $$
begin
  if new.review_id is not null and (tg_op = 'INSERT' or new.review_id is distinct from old.review_id) then
    perform 1 from reviews where id = new.review_id and archived_at is null for share;
    if not found and exists (select 1 from reviews where id = new.review_id) then
      raise exception 'review % is archived', new.review_id
        using errcode = 'check_violation', constraint = 'tasks_review_not_archived';
    end if;
    -- a review id that does not exist is reported by the foreign key
  end if;
  return new;
end;
$$;

create trigger tasks_check_review_link before insert or update of review_id on tasks
  for each row execute function check_task_review_link();
