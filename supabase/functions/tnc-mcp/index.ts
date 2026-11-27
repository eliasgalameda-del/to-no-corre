import { createMcpHandler, McpServer } from 'npm:@modelcontextprotocol/server@^2.0.0';
import { pipeline } from 'npm:@supabase/middleware@1';
import { withOAuthProtectedResource, withSupabase } from 'npm:@supabase/server@1';
import { z } from 'npm:zod@^4.3.6';

const ITEM_TYPES = ['event', 'task'] as const;
const CONTEXTS = ['personal', 'student', 'professional'] as const;
const RECURRENCES = ['none', 'daily', 'weekly', 'biweekly', 'monthly'] as const;
const TASK_RECURRENCES = ['none', 'daily', 'weekly'] as const;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const idSchema = z.string().regex(ID_RE, 'ID must be 1–128 safe characters');
const text = (max: number) => z.string().min(1).max(max).regex(/\S/, 'Must include a non-space character');
const optionalText = (max: number) => z.string().max(max);
const contextSchema = z.enum(CONTEXTS);
const eventRecurrenceSchema = z.enum(RECURRENCES);
const taskRecurrenceSchema = z.enum(TASK_RECURRENCES);
const isoDateSchema = z.iso.date();
const taskDateSchema = z.union([isoDateSchema, z.literal('')]);
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const boundedMinutes = z.number().int().min(0).max(24 * 60);
const loggedMinutes = z.number().int().min(0).max(100000);
const safeVersion = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const boundedIdArray = z.array(idSchema).max(50);
const subtaskSchema = z.object({
  id: idSchema,
  text: text(200),
  done: z.boolean(),
}).strict();
const subtasksSchema = z.array(subtaskSchema).max(50);
const tagsSchema = z.array(text(64)).max(30);

// Create inputs are strict. Caller-supplied item IDs let the CAS RPC enforce
// insert-if-absent semantics without accepting arbitrary payload fields.
const eventFields = {
  id: idSchema,
  title: text(200),
  context: contextSchema.optional(),
  date: isoDateSchema,
  time: timeSchema.optional(),
  duration: boundedMinutes.optional(),
  desc: optionalText(2000).optional(),
  recurrence: eventRecurrenceSchema.optional(),
  done: z.boolean().optional(),
  monthlyType: z.enum(['exact', 'weekday', 'weekOfMonth']).optional(),
  monthlyDay: z.number().int().min(1).max(31).optional(),
  monthlyWeek: z.number().int().min(1).max(5).optional(),
  monthlyDow: z.number().int().min(0).max(6).optional(),
  skipHolidayWeekend: z.boolean().optional(),
};
const eventCreateSchema = z.object({
  id: idSchema,
  title: text(200),
  context: contextSchema.default('personal'),
  date: isoDateSchema,
  time: timeSchema.default('00:00'),
  duration: boundedMinutes.default(0),
  desc: optionalText(2000).default(''),
  recurrence: eventRecurrenceSchema.default('none'),
  done: z.boolean().default(false),
  monthlyType: z.enum(['exact', 'weekday', 'weekOfMonth']).optional(),
  monthlyDay: z.number().int().min(1).max(31).optional(),
  monthlyWeek: z.number().int().min(1).max(5).optional(),
  monthlyDow: z.number().int().min(0).max(6).optional(),
  skipHolidayWeekend: z.boolean().optional(),
}).strict();
const eventPatchSchema = z.object({
  title: text(200).optional(),
  context: contextSchema.optional(),
  date: isoDateSchema.optional(),
  time: timeSchema.optional(),
  duration: boundedMinutes.optional(),
  desc: optionalText(2000).optional(),
  recurrence: eventRecurrenceSchema.optional(),
  done: z.boolean().optional(),
  monthlyType: z.enum(['exact', 'weekday', 'weekOfMonth']).optional(),
  monthlyDay: z.number().int().min(1).max(31).optional(),
  monthlyWeek: z.number().int().min(1).max(5).optional(),
  monthlyDow: z.number().int().min(0).max(6).optional(),
  skipHolidayWeekend: z.boolean().optional(),
}).strict();
const eventStoredSchema = z.object(eventFields);

const taskFields = {
  id: idSchema,
  title: text(200),
  context: contextSchema.optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  status: z.enum(['todo', 'doing', 'done']).optional(),
  deadline: taskDateSchema.optional(),
  tags: tagsSchema.optional(),
  estimateMins: boundedMinutes.optional(),
  loggedMins: loggedMinutes.optional(),
  recurrence: taskRecurrenceSchema.optional(),
  dependsOn: boundedIdArray.optional(),
  subtasks: subtasksSchema.optional(),
  desc: optionalText(2000).optional(),
};
const taskCreateSchema = z.object({
  id: idSchema,
  title: text(200),
  context: contextSchema.default('personal'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  status: z.enum(['todo', 'doing', 'done']).default('todo'),
  deadline: taskDateSchema.default(''),
  tags: tagsSchema.default([]),
  estimateMins: boundedMinutes.default(0),
  loggedMins: loggedMinutes.default(0),
  recurrence: taskRecurrenceSchema.default('none'),
  dependsOn: boundedIdArray.default([]),
  subtasks: subtasksSchema.default([]),
  desc: optionalText(2000).default(''),
}).strict();
const taskPatchSchema = z.object({
  title: text(200).optional(),
  context: contextSchema.optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  status: z.enum(['todo', 'doing', 'done']).optional(),
  deadline: taskDateSchema.optional(),
  tags: tagsSchema.optional(),
  estimateMins: boundedMinutes.optional(),
  loggedMins: loggedMinutes.optional(),
  recurrence: taskRecurrenceSchema.optional(),
  dependsOn: boundedIdArray.optional(),
  subtasks: subtasksSchema.optional(),
  desc: optionalText(2000).optional(),
}).strict();
const taskStoredSchema = z.object(taskFields);

const listSchema = z.object({
  item_type: z.enum(ITEM_TYPES),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(10000).default(0),
}).strict();
const createSchema = z.discriminatedUnion('item_type', [
  z.object({ item_type: z.literal('event'), item: eventCreateSchema }).strict(),
  z.object({ item_type: z.literal('task'), item: taskCreateSchema }).strict(),
]);
const updateSchema = z.discriminatedUnion('item_type', [
  z.object({ item_type: z.literal('event'), item_id: idSchema, expected_version: safeVersion, changes: eventPatchSchema }).strict(),
  z.object({ item_type: z.literal('task'), item_id: idSchema, expected_version: safeVersion, changes: taskPatchSchema }).strict(),
]);
const deleteSchema = z.object({
  item_type: z.enum(ITEM_TYPES),
  item_id: idSchema,
  expected_version: safeVersion,
}).strict();

type ItemType = typeof ITEM_TYPES[number];
type JsonObject = Record<string, unknown>;
type AgendaRow = { item_type: ItemType; item_id: string; payload: unknown; version: number; updated_at?: string };
type SafeAgendaItem = { item_type: ItemType; item_id: string; version: number; updated_at?: string; payload: JsonObject };
type CasResult = { status: 'applied' | 'conflict' | 'not_found'; version?: number; payload?: unknown };

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePayload(itemType: ItemType, itemId: string, value: unknown): JsonObject | null {
  if (!isObject(value) || value._deleted === true) return null;
  const schema = itemType === 'event' ? eventStoredSchema : taskStoredSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data.id !== itemId) return null;
  // Zod's ordinary object schemas strip unknown stored keys. Never return the
  // complete DB JSON payload to an MCP caller.
  return parsed.data as JsonObject;
}

function safeRow(row: AgendaRow): SafeAgendaItem | null {
  if (!ITEM_TYPES.includes(row.item_type) || !Number.isSafeInteger(row.version) || row.version < 1) return null;
  const payload = parsePayload(row.item_type, row.item_id, row.payload);
  if (!payload) return null;
  const result: SafeAgendaItem = { item_type: row.item_type, item_id: row.item_id, version: row.version, payload };
  if (typeof row.updated_at === 'string') result.updated_at = row.updated_at;
  return result;
}

function decodeCasResult(data: unknown): CasResult | null {
  let decoded = data;
  // The Supabase JS RPC client normally parses jsonb to an object; accept a
  // JSON string too, but only after validating the exact result contract.
  if (typeof decoded === 'string') {
    try { decoded = JSON.parse(decoded); } catch { return null; }
  }
  if (!isObject(decoded) || !['applied', 'conflict', 'not_found'].includes(String(decoded.status))) return null;
  const status = decoded.status as CasResult['status'];
  if (status === 'not_found') return { status };
  if (!Number.isSafeInteger(decoded.version) || Number(decoded.version) < 1) return null;
  return { status, version: Number(decoded.version), payload: decoded.payload };
}

function textResult(value: unknown, isError = false) {
  return { isError, content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function failure(code: string) {
  return textResult({ status: 'error', code }, true);
}

Deno.serve(pipeline(
  [withOAuthProtectedResource(), withSupabase({ auth: 'user' })],
  async (req, { supabase }) => {
    const callerId = async (): Promise<string | null> => {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) return null;
      return data.user.id;
    };

    const syncEnabled = async (): Promise<boolean | null> => {
      const { data, error } = await supabase.rpc('agenda_sync_enabled');
      if (error || typeof data !== 'boolean') return null;
      return data;
    };

    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'to-no-corre', version: '0.2.0' });
      server.registerTool('verificar_conexao', {
        title: 'Verificar conexão',
        description: 'Confirma que a conta autorizada está conectada ao Tô no Corre. Não modifica dados.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      }, async () => {
        const uid = await callerId();
        if (!uid) return failure('authentication_required');
        return textResult({ status: 'connected', service: 'Tô no Corre' });
      });

      server.registerTool('listar_itens_agenda', {
        title: 'Listar eventos ou tarefas',
        description: 'Lê eventos ou tarefas da agenda da conta autorizada. Retorna apenas campos conhecidos do tipo escolhido, sem itens cancelados; não modifica dados. Use paginação limit/offset.',
        inputSchema: listSchema,
        annotations: { readOnlyHint: true },
      }, async (args) => {
        const input = listSchema.parse(args);
        const uid = await callerId();
        if (!uid) return failure('authentication_required');
        const { data, error } = await supabase.from('agenda_items')
          .select('item_type,item_id,payload,version,updated_at')
          .eq('user_id', uid)
          .eq('item_type', input.item_type)
          .order('item_id', { ascending: true })
          .range(input.offset, input.offset + input.limit - 1);
        if (error || !Array.isArray(data)) return failure('agenda_read_failed');
        const items = (data as AgendaRow[]).map(safeRow).filter((row): row is SafeAgendaItem => row !== null);
        return textResult({ status: 'ok', item_type: input.item_type, items, next_offset: input.offset + data.length, has_more: data.length === input.limit });
      });

      server.registerTool('criar_item_agenda', {
        title: 'Criar evento ou tarefa',
        description: 'Cria um evento ou tarefa somente quando a pessoa pedir explicitamente. A gravação é imediata na agenda da conta autorizada, depende do sinalizador de sincronização habilitado e usa agenda_item_cas com ID fornecido pelo chamador: cria apenas se ainda não existir (versão inicial 1); uma colisão retorna conflito, nunca sobrescreve. Aceita exclusivamente campos do tipo evento/tarefa do Tô no Corre.',
        inputSchema: createSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      }, async (args) => {
        const input = createSchema.parse(args);
        const uid = await callerId();
        if (!uid) return failure('authentication_required');
        const enabled = await syncEnabled();
        if (enabled === null) return failure('agenda_sync_state_unavailable');
        if (!enabled) return failure('agenda_sync_disabled');
        const parsed = input.item_type === 'event' ? eventCreateSchema.safeParse(input.item) : taskCreateSchema.safeParse(input.item);
        if (!parsed.success) return failure('invalid_item_fields');
        const payload = parsed.data as unknown as JsonObject;
        const itemId = String(payload.id);
        const { data, error } = await supabase.rpc('agenda_item_cas', {
          p_item_type: input.item_type,
          p_item_id: itemId,
          p_payload: payload,
          p_expected_version: null,
          p_is_delete: false,
        });
        if (error) return failure('agenda_write_failed');
        const result = decodeCasResult(data);
        if (!result) return failure('invalid_cas_response');
        if (result.status === 'applied') return textResult({ status: 'applied', item_type: input.item_type, item_id: itemId, version: result.version, payload: parsePayload(input.item_type, itemId, result.payload) });
        if (result.status === 'conflict') return textResult({ status: 'conflict', item_type: input.item_type, item_id: itemId, version: result.version, current: parsePayload(input.item_type, itemId, result.payload) });
        return textResult({ status: 'not_found', item_type: input.item_type, item_id: itemId });
      });

      server.registerTool('atualizar_item_agenda', {
        title: 'Atualizar ou reagendar item',
        description: 'Atualiza campos conhecidos de um evento ou tarefa da conta autorizada (inclui reagendar alterando date/time ou deadline). A pessoa deve pedir a alteração explicitamente. expected_version é obrigatório: grava somente se a versão ainda for exata; conflito preserva o dado no servidor. Campos omitidos são mantidos após leitura e a escrita é feita exclusivamente por agenda_item_cas. Depende do sinalizador de sincronização habilitado.',
        inputSchema: updateSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      }, async (args) => {
        const input = updateSchema.parse(args);
        const uid = await callerId();
        if (!uid) return failure('authentication_required');
        const enabled = await syncEnabled();
        if (enabled === null) return failure('agenda_sync_state_unavailable');
        if (!enabled) return failure('agenda_sync_disabled');
        const patch = input.item_type === 'event' ? eventPatchSchema.safeParse(input.changes) : taskPatchSchema.safeParse(input.changes);
        if (!patch.success || Object.keys(patch.data).length === 0) return failure('invalid_item_fields');
        const { data: row, error: readError } = await supabase.from('agenda_items')
          .select('item_type,item_id,payload,version,updated_at')
          .eq('user_id', uid).eq('item_type', input.item_type).eq('item_id', input.item_id)
          .maybeSingle();
        if (readError) return failure('agenda_read_failed');
        if (!row) return textResult({ status: 'not_found', item_type: input.item_type, item_id: input.item_id });
        const storedRow = row as AgendaRow;
        if (isObject(storedRow.payload) && storedRow.payload._deleted === true) return textResult({ status: 'not_found', item_type: input.item_type, item_id: input.item_id });
        const current = safeRow(storedRow);
        if (!current) return failure('invalid_stored_item');
        if (current.version !== input.expected_version) return textResult({ status: 'conflict', item_type: input.item_type, item_id: input.item_id, version: current.version, current: current.payload });
        const merged = { ...current.payload, ...patch.data };
        const full = input.item_type === 'event' ? eventStoredSchema.safeParse(merged) : taskStoredSchema.safeParse(merged);
        if (!full.success || full.data.id !== input.item_id) return failure('invalid_merged_item');
        const { data, error } = await supabase.rpc('agenda_item_cas', {
          p_item_type: input.item_type,
          p_item_id: input.item_id,
          p_payload: full.data,
          p_expected_version: input.expected_version,
          p_is_delete: false,
        });
        if (error) return failure('agenda_write_failed');
        const result = decodeCasResult(data);
        if (!result) return failure('invalid_cas_response');
        if (result.status === 'applied') return textResult({ status: 'applied', item_type: input.item_type, item_id: input.item_id, version: result.version, payload: parsePayload(input.item_type, input.item_id, result.payload) });
        if (result.status === 'conflict') return textResult({ status: 'conflict', item_type: input.item_type, item_id: input.item_id, version: result.version, current: parsePayload(input.item_type, input.item_id, result.payload) });
        return textResult({ status: 'not_found', item_type: input.item_type, item_id: input.item_id });
      });

      server.registerTool('cancelar_item_agenda', {
        title: 'Cancelar ou excluir item',
        description: 'Cancela/exclui logicamente um evento ou tarefa da conta autorizada somente após pedido explícito. expected_version é obrigatório; uma versão divergente retorna conflito sem apagar. agenda_item_cas grava um tombstone versionado (não remove fisicamente a linha), e itens cancelados deixam de aparecer na listagem. Depende do sinalizador de sincronização habilitado.',
        inputSchema: deleteSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      }, async (args) => {
        const input = deleteSchema.parse(args);
        const uid = await callerId();
        if (!uid) return failure('authentication_required');
        const enabled = await syncEnabled();
        if (enabled === null) return failure('agenda_sync_state_unavailable');
        if (!enabled) return failure('agenda_sync_disabled');
        const { data, error } = await supabase.rpc('agenda_item_cas', {
          p_item_type: input.item_type,
          p_item_id: input.item_id,
          p_payload: null,
          p_expected_version: input.expected_version,
          p_is_delete: true,
        });
        if (error) return failure('agenda_write_failed');
        const result = decodeCasResult(data);
        if (!result) return failure('invalid_cas_response');
        if (result.status === 'applied') return textResult({ status: 'cancelled', item_type: input.item_type, item_id: input.item_id, version: result.version });
        if (result.status === 'conflict') return textResult({ status: 'conflict', item_type: input.item_type, item_id: input.item_id, version: result.version, current: parsePayload(input.item_type, input.item_id, result.payload) });
        return textResult({ status: 'not_found', item_type: input.item_type, item_id: input.item_id });
      });

      return server;
    });
    return handler.fetch(req);
  },
));
