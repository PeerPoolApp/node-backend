/** Real PostgreSQL regression tests for the production migration; no remote database. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
const viewer = '00000000-0000-0000-0000-000000000001'
const sender = '00000000-0000-0000-0000-000000000002'
const outsider = '00000000-0000-0000-0000-000000000003'
const chat = '10000000-0000-0000-0000-000000000001'
const other = '10000000-0000-0000-0000-000000000002'
const first = '20000000-0000-0000-0000-000000000001'
const second = '20000000-0000-0000-0000-000000000002'
const fixture = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated;
create table public.conversations (id uuid primary key, archived_at timestamptz, updated_at timestamptz);
create table public.conversation_members (conversation_id uuid, user_id uuid, last_read_at timestamptz, primary key (conversation_id,user_id));
create table public.messages (id uuid primary key default gen_random_uuid(), conversation_id uuid, sender_id uuid, created_at timestamptz default now(), deleted_at timestamptz, moderation_hidden_at timestamptz,
  client_id uuid, body text, reply_to_id uuid, unique(sender_id,client_id));
create table public.message_attachments (id uuid default gen_random_uuid(), message_id uuid references public.messages(id),
  storage_path text not null, mime_type text not null, size_bytes bigint check(size_bytes>0), file_name text not null);
create table public.events (conversation_id uuid, organizer_community_id uuid);
create table public.content_hides (user_id uuid, target_kind text, target_id uuid);
insert into public.conversations (id,archived_at) values ('${chat}', null), ('${other}',null);
insert into public.conversation_members values ('${chat}','${viewer}',null), ('${chat}','${sender}',null), ('${other}','${viewer}',null);
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
grant select on public.conversation_members, public.messages to authenticated;
create policy messages_select_member on public.messages for select to authenticated using (exists
  (select 1 from public.conversation_members cm where cm.conversation_id = messages.conversation_id and cm.user_id=auth.uid()));
insert into public.messages (id,conversation_id,sender_id,created_at,deleted_at,moderation_hidden_at) values ('${first}','${chat}','${sender}','2026-10-23T10:00:00.123456Z',null,null),
('${second}','${chat}','${sender}','2026-10-23T10:00:00.123456Z',null,null);
`
async function database() {
  const db = new PGlite()
  await db.exec(fixture)
  await db.exec(
    await readFile(
      new URL(
        '../../../database/migration/20261023120000_messaging_reliability.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  return db
}

test('membership RLS is nonrecursive and excludes non-members; RPCs stay server-only', async () => {
  const db = await database()
  try {
    await db.exec(
      `set role authenticated; select set_config('request.jwt.claim.sub','${viewer}',false);`,
    )
    assert.equal((await db.query('select * from public.messages')).rows.length, 2)
    await db.exec(`select set_config('request.jwt.claim.sub','${outsider}',false)`)
    assert.equal((await db.query('select * from public.messages')).rows.length, 0)
    assert.equal((await db.query('select * from public.conversation_members')).rows.length, 0)
    await assert.rejects(
      db.query(`select * from public.message_unread_counts('${viewer}')`),
      /permission denied/,
    )
    await assert.rejects(
      db.query(`select * from public.mark_conversation_read('${viewer}','${chat}','${second}')`),
      /permission denied/,
    )
  } finally {
    await db.close()
  }
})

test('read cursor validates membership/conversation, is monotonic and preserves timestamp ties', async () => {
  const db = await database()
  try {
    await db.query(`select * from public.mark_conversation_read('${viewer}','${chat}','${first}')`)
    let rows = (
      await db.query<{ unread_count: number }>(
        `select * from public.message_unread_counts('${viewer}',array['${chat}'::uuid])`,
      )
    ).rows
    assert.equal(Number(rows[0]!.unread_count), 1)
    await db.query(`select * from public.mark_conversation_read('${viewer}','${chat}','${second}')`)
    await db.query(`select * from public.mark_conversation_read('${viewer}','${chat}','${first}')`)
    rows = (
      await db.query<{ unread_count: number }>(
        `select * from public.message_unread_counts('${viewer}',array['${chat}'::uuid])`,
      )
    ).rows
    assert.equal(Number(rows[0]!.unread_count), 0)
    await assert.rejects(
      db.query(`select * from public.mark_conversation_read('${viewer}','${other}','${second}')`),
      /not available/,
    )
    await assert.rejects(
      db.query(`select * from public.mark_conversation_read('${outsider}','${chat}','${second}')`),
      /Not a member/,
    )
  } finally {
    await db.close()
  }
})

test('exact unread counts exceed 1000 and exclude own, deleted, hidden and incomplete messages', async () => {
  const db = await database()
  try {
    await db.exec(`insert into public.messages (id,conversation_id,sender_id,created_at)
      select md5(i::text)::uuid, '${chat}', '${sender}', '2026-10-23T11:00:00Z' from generate_series(1,1100) i;
      insert into public.content_hides values ('${viewer}','message','${first}');
      update public.messages set moderation_hidden_at=now() where id='${second}';
      update public.messages set delivery_ready=false where id=md5('1')::uuid;
      update public.messages set deleted_at=now() where id=md5('2')::uuid;
      update public.messages set sender_id='${viewer}' where id=md5('3')::uuid;`)
    const rows = (
      await db.query<{ unread_count: number; include_in_main: boolean }>(
        `select * from public.message_unread_counts('${viewer}',array['${chat}'::uuid])`,
      )
    ).rows
    assert.equal(Number(rows[0]!.unread_count), 1097)
    assert.equal(rows[0]!.include_in_main, true)
    await db.exec(`insert into public.events values ('${chat}','${other}')`)
    assert.equal(
      (
        await db.query<{ include_in_main: boolean }>(
          `select * from public.message_unread_counts('${viewer}',array['${chat}'::uuid])`,
        )
      ).rows[0]!.include_in_main,
      false,
    )
    await db.exec(
      `delete from public.events; update public.conversations set archived_at=now() where id='${chat}'`,
    )
    assert.equal(
      (
        await db.query<{ include_in_main: boolean }>(
          `select * from public.message_unread_counts('${viewer}',array['${chat}'::uuid])`,
        )
      ).rows[0]!.include_in_main,
      false,
    )
  } finally {
    await db.close()
  }
})

test('commit is atomic, returns complete attachments, and is idempotent for concurrent retries', async () => {
  const db = await database()
  const client = '30000000-0000-0000-0000-000000000001'
  const image = JSON.stringify([
    { storagePath: 'image.webp', mimeType: 'image/webp', sizeBytes: 12, fileName: 'image.webp' },
  ])
  try {
    const send = () =>
      db.query<{ message: { id: string; message_attachments: unknown[] }; inserted: boolean }>(
        'select * from public.commit_chat_message($1,$2,$3,$4,$5,$6)',
        [chat, sender, client, 'hello', first, image],
      )
    const [one, two] = await Promise.all([send(), send()])
    assert.equal(one.rows[0]!.message.id, two.rows[0]!.message.id)
    assert.deepEqual([one.rows[0]!.inserted, two.rows[0]!.inserted].sort(), [false, true])
    assert.equal(one.rows[0]!.message.message_attachments.length, 1)
    const broken = JSON.stringify([
      { storagePath: 'bad', mimeType: 'image/webp', sizeBytes: -1, fileName: 'bad' },
    ])
    await assert.rejects(
      db.query('select * from public.commit_chat_message($1,$2,$3,$4,$5,$6)', [
        chat,
        sender,
        '30000000-0000-0000-0000-000000000002',
        'bad',
        null,
        broken,
      ]),
      /check constraint/,
    )
    assert.equal((await db.query("select * from public.messages where body='bad'")).rows.length, 0)
  } finally {
    await db.close()
  }
})
