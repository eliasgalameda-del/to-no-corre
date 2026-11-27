import { createMcpHandler, McpServer } from 'npm:@modelcontextprotocol/server@^2.0.0';
import { pipeline } from 'npm:@supabase/middleware@1';
import { withOAuthProtectedResource, withSupabase } from 'npm:@supabase/server@1';
import { z } from 'npm:zod@^4.3.6';

Deno.serve(pipeline(
  [withOAuthProtectedResource(), withSupabase({ auth: 'user' })],
  async (req, { supabase }) => {
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'to-no-corre', version: '0.1.0' });
      server.registerTool('verificar_conexao', {
        title: 'Verificar conexão',
        description: 'Confirma que a conta autorizada está conectada ao Tô no Corre. Não modifica dados.',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      }, async () => {
        const { data, error } = await supabase.auth.getUser();
        if (error || !data.user) return { isError: true, content: [{ type: 'text', text: 'Não foi possível validar a conta.' }] };
        return { content: [{ type: 'text', text: 'Conexão autenticada com o Tô no Corre.' }] };
      });
      return server;
    });
    return handler.fetch(req);
  },
));
