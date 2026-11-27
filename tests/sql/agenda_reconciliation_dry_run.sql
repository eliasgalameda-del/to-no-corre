-- Read-only pre-cutover reconciliation report. Safe for the production project.
-- Emits counts, per-user/type projection checksums, item IDs, issue labels, and
-- differing JSON field NAMES only. It never returns titles/descriptions/values
-- and contains no DML/DDL. A nonzero diff is a review queue, never a winner rule.
with
legacy_arrays as (
  select k.user_id,
         case k.key when 'agendaplus_events' then 'event' else 'task' end as item_type,
         k.value
  from public.kv k
  where k.key in ('agendaplus_events', 'agendaplus_tasks')
),
legacy_stats as (
  select user_id, item_type,
         sum(case when jsonb_typeof(value) = 'array' then jsonb_array_length(value) else 0 end)::int as array_rows,
         sum(case when jsonb_typeof(value) = 'array' then 0 else 1 end)::int as non_array_values
  from legacy_arrays
  group by user_id, item_type
),
legacy_elements as (
  select a.user_id, a.item_type, x.item as payload,
         case when jsonb_typeof(x.item) = 'object' then x.item->>'id' end as item_id
  from legacy_arrays a
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(a.value) = 'array' then a.value else '[]'::jsonb end
  ) x(item)
),
legacy_invalid as (
  select user_id, item_type, count(*)::int as invalid_rows
  from legacy_elements
  where jsonb_typeof(payload) <> 'object'
     or item_id is null
     or length(btrim(item_id)) = 0
  group by user_id, item_type
),
legacy_items as (
  select user_id, item_type, item_id,
         count(*)::int as copies,
         case when count(*) = 1 then min(md5(payload::text))
              else md5(string_agg(md5(payload::text), ',' order by md5(payload::text)))
         end as item_hash,
         case when count(*) = 1 then min(payload::text)::jsonb end as sole_payload
  from legacy_elements
  where jsonb_typeof(payload) = 'object'
    and item_id is not null
    and length(btrim(item_id)) > 0
  group by user_id, item_type, item_id
),
normalized_items as (
  select user_id, item_type, item_id, payload,
         md5(payload::text) as item_hash
  from public.agenda_items
  where payload->>'_deleted' is distinct from 'true'
),
all_pairs as (
  select user_id, item_type from legacy_arrays
  union
  select user_id, item_type from public.agenda_items
),
legacy_checksums as (
  select user_id, item_type,
         count(*)::int as valid_unique_ids,
         sum(copies)::int as valid_rows,
         count(*) filter (where copies > 1)::int as duplicate_ids,
         md5(coalesce(jsonb_agg(jsonb_build_array(item_id, copies, item_hash)
             order by item_id)::text, '[]')) as checksum
  from legacy_items
  group by user_id, item_type
),
normalized_checksums as (
  select user_id, item_type,
         count(*)::int as live_rows,
         md5(coalesce(jsonb_agg(jsonb_build_array(item_id, 1, item_hash)
             order by item_id)::text, '[]')) as checksum
  from normalized_items
  group by user_id, item_type
),
differences as (
  select coalesce(l.user_id, n.user_id) as user_id,
         coalesce(l.item_type, n.item_type) as item_type,
         coalesce(l.item_id, n.item_id) as item_id,
         l.copies as legacy_copies,
         l.item_hash as legacy_hash,
         n.item_hash as normalized_hash,
         case
           when l.item_id is null then 'normalized_only'
           when n.item_id is null then 'legacy_only'
           when l.copies > 1 then 'duplicate_legacy_id'
           when l.item_hash is distinct from n.item_hash then 'payload_diff'
         end as issue,
         case when l.copies = 1 and n.item_id is not null
           then (select array_agg(field_name order by field_name)
                 from (
                   select jsonb_object_keys(l.sole_payload) as field_name
                   union
                   select jsonb_object_keys(n.payload) as field_name
                 ) fields
                 where l.sole_payload->field_name is distinct from n.payload->field_name)
           else null
         end as differing_field_names
  from legacy_items l
  full join normalized_items n using (user_id, item_type, item_id)
  where l.item_id is null
     or n.item_id is null
     or l.copies > 1
     or l.item_hash is distinct from n.item_hash
)
select jsonb_build_object(
  'feature_enabled', (select enabled from public.agenda_sync_control where singleton = true),
  'users_and_types', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', p.user_id,
      'type', p.item_type,
      'legacy_array_rows', coalesce(ls.array_rows, 0),
      'legacy_non_array_values', coalesce(ls.non_array_values, 0),
      'legacy_valid_rows', coalesce(lc.valid_rows, 0),
      'legacy_unique_ids', coalesce(lc.valid_unique_ids, 0),
      'legacy_invalid_rows', coalesce(li.invalid_rows, 0),
      'legacy_duplicate_ids', coalesce(lc.duplicate_ids, 0),
      'normalized_live_rows', coalesce(nc.live_rows, 0),
      'legacy_projection_checksum', lc.checksum,
      'normalized_projection_checksum', nc.checksum,
      'diff_ids', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', d.item_id,
          'issue', d.issue,
          'legacy_hash', d.legacy_hash,
          'normalized_hash', d.normalized_hash,
          'differing_field_names', d.differing_field_names
        ) order by d.item_id)
        from differences d
        where d.user_id = p.user_id and d.item_type = p.item_type
      ), '[]'::jsonb)
    ) order by p.user_id, p.item_type), '[]'::jsonb)
    from all_pairs p
    left join legacy_stats ls using (user_id, item_type)
    left join legacy_checksums lc using (user_id, item_type)
    left join legacy_invalid li using (user_id, item_type)
    left join normalized_checksums nc using (user_id, item_type)
  )
) as report;
