"""Offline contract checks for the staged Tô no Corre MCP agenda tools.

These checks intentionally do not stand in for Deno/Postgres authenticated tests.
"""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "supabase/functions/tnc-mcp/index.ts").read_text(encoding="utf-8")


class McpAgendaContractTests(unittest.TestCase):
    def test_tools_are_registered_and_user_auth_is_mandatory(self):
        for name in (
            "verificar_conexao",
            "listar_itens_agenda",
            "criar_item_agenda",
            "atualizar_item_agenda",
            "cancelar_item_agenda",
        ):
            self.assertIn(f"registerTool('{name}'", SOURCE)
        self.assertIn("withSupabase({ auth: 'user' })", SOURCE)
        self.assertIn("supabase.auth.getUser()", SOURCE)
        self.assertNotIn("service_role", SOURCE)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", SOURCE)

    def test_reads_are_caller_and_type_scoped_and_bounded(self):
        self.assertIn(".eq('user_id', uid)", SOURCE)
        self.assertIn(".eq('item_type', input.item_type)", SOURCE)
        self.assertIn(".eq('item_id', input.item_id)", SOURCE)
        self.assertIn("limit: z.number().int().min(1).max(100).default(50)", SOURCE)
        self.assertIn("offset: z.number().int().min(0).max(10000).default(0)", SOURCE)
        self.assertIn(".range(input.offset, input.offset + input.limit - 1)", SOURCE)
        self.assertIn("value._deleted === true", SOURCE)
        self.assertIn("storedRow.payload._deleted === true", SOURCE)
        self.assertIn("status: 'not_found'", SOURCE)

    def test_input_objects_are_strict_and_only_allow_agenda_fields(self):
        for schema in (
            "eventCreateSchema",
            "eventPatchSchema",
            "taskCreateSchema",
            "taskPatchSchema",
            "listSchema",
            "deleteSchema",
        ):
            self.assertIn(f"const {schema} = z.object(", SOURCE)
        self.assertIn("const createSchema = z.discriminatedUnion('item_type'", SOURCE)
        self.assertIn("const updateSchema = z.discriminatedUnion('item_type'", SOURCE)
        self.assertIn("}).strict()", SOURCE)
        self.assertIn("Object.keys(patch.data).length === 0", SOURCE)
        self.assertIn("ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/", SOURCE)
        self.assertIn("const isoDateSchema = z.iso.date()", SOURCE)
        self.assertIn("text = (max: number) => z.string().min(1).max(max).regex(/\\S/", SOURCE)
        self.assertIn("text(200)", SOURCE)
        self.assertIn("optionalText(2000)", SOURCE)
        self.assertIn("z.array(text(64)).max(30)", SOURCE)
        self.assertIn("z.array(subtaskSchema).max(50)", SOURCE)
        self.assertNotIn("user_id:", SOURCE)

    def test_all_mutations_use_only_the_cas_rpc_with_exact_arguments(self):
        self.assertEqual(SOURCE.count("supabase.rpc('agenda_item_cas'"), 3)
        for arg in (
            "p_item_type:",
            "p_item_id:",
            "p_payload:",
            "p_expected_version:",
            "p_is_delete:",
        ):
            self.assertGreaterEqual(SOURCE.count(arg), 3)
        self.assertIn("p_expected_version: null", SOURCE)
        self.assertIn("p_expected_version: input.expected_version", SOURCE)
        self.assertIn("p_is_delete: true", SOURCE)
        self.assertIn("safeVersion = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)", SOURCE)
        self.assertIn("if (!enabled) return failure('agenda_sync_disabled')", SOURCE)
        self.assertNotIn(".insert(", SOURCE)
        self.assertNotIn(".update(", SOURCE)
        self.assertNotIn(".delete(", SOURCE)

    def test_event_color_survives_reads_and_updates(self):
        color_schema = "color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()"
        self.assertEqual(SOURCE.count(color_schema), 3)
        # The stored schema used by safeRow and the patch schema both retain
        # the app's existing hex color field during read/merge/update.
        self.assertIn("const eventStoredSchema = z.object(eventFields)", SOURCE)
        self.assertIn("const merged = { ...current.payload, ...patch.data }", SOURCE)

    def test_rpc_results_are_validated_and_outputs_whitelist_payload(self):
        self.assertIn("JSON.parse(decoded)", SOURCE)
        self.assertIn("['applied', 'conflict', 'not_found']", SOURCE)
        self.assertIn("schema.safeParse(value)", SOURCE)
        self.assertIn("return parsed.data as JsonObject", SOURCE)
        self.assertIn("status: 'cancelled'", SOURCE)
        self.assertIn("The Supabase JS RPC client normally parses jsonb to an object", SOURCE)

    def test_delimiters_are_balanced(self):
        # Lightweight offline guard only (not a TypeScript parser/type-checker).
        pairs = {')': '(', ']': '[', '}': '{'}
        opening = set(pairs.values())
        stack = []
        quote = None
        escaped = False
        line_comment = False
        block_comment = False
        i = 0
        while i < len(SOURCE):
            char = SOURCE[i]
            nxt = SOURCE[i + 1] if i + 1 < len(SOURCE) else ''
            if line_comment:
                if char == '\n':
                    line_comment = False
                i += 1
                continue
            if block_comment:
                if char == '*' and nxt == '/':
                    block_comment = False
                    i += 2
                    continue
                i += 1
                continue
            if quote:
                if escaped:
                    escaped = False
                elif char == '\\':
                    escaped = True
                elif char == quote:
                    quote = None
                i += 1
                continue
            if char == '/' and nxt == '/':
                line_comment = True
                i += 2
                continue
            if char == '/' and nxt == '*':
                block_comment = True
                i += 2
                continue
            if char in "'\"`":
                quote = char
            elif char in opening:
                stack.append((char, i))
            elif char in pairs:
                self.assertTrue(stack, f"unexpected {char} at {i}")
                found, _ = stack.pop()
                self.assertEqual(found, pairs[char], f"mismatched {char} at {i}")
            i += 1
        self.assertIsNone(quote, "unterminated string/template literal")
        self.assertFalse(block_comment, "unterminated block comment")
        self.assertEqual(stack, [], "unclosed delimiter")


if __name__ == "__main__":
    unittest.main()
