import { z } from "zod";
import { McpError, ErrorCode } from '../errors.js';
import { ProductiveAPIClient } from "../api/client.js";
import { READ, result, type RegisterTools } from './context.js';

export const listUsersSchema = z.object({});

/**
 * List internal Productive users.
 *
 * Available to every signed-in user, but always run as the "productive-bot" system user through
 * apps.functn.com Connections (allowed there: GET people, GET custom_roles), because a personal
 * token may not list everyone. The bot has limited permissions and holds no write access here.
 */
export async function listUsers(
  client: ProductiveAPIClient,
  args: unknown,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    listUsersSchema.parse(args);

    const baseConfig = client.getConfig();
    if (!baseConfig.systemTransport) {
      throw new McpError(ErrorCode.InvalidRequest, 'list_users is not available on this server.', 'not_configured');
    }
    // A one-off client that calls Productive as the bot for this single call.
    const botClient = new ProductiveAPIClient({ ...baseConfig, transport: baseConfig.systemTransport });

    const { people, rolesById } = await botClient.listUsers();

    const users = people.map((p) => {
      const fullName =
        `${p.attributes.first_name ?? ""} ${p.attributes.last_name ?? ""}`.trim();
      const roleId = p.relationships?.custom_role?.data?.id as
        | string
        | undefined;
      return {
        id: p.id,
        name: fullName,
        email: p.attributes.email,
        role_id: roleId ?? null,
        role: roleId ? (rolesById.get(String(roleId)) ?? null) : null,
      };
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ count: users.length, users }, null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof McpError) throw error;
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.issues.map((e: z.ZodIssue) => e.message).join(", ")}`,
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      error instanceof Error ? error.message : "Unknown error occurred",
    );
  }
}

export const registerUserTools: RegisterTools = (server, { client }) => {
  server.registerTool(
    "list_users",
    {
      title: "List users",
      description: "List all internal users (active, login-able people; no contacts, placeholders or agents) with id, name, email and role.",
      inputSchema: listUsersSchema,
      annotations: READ,
    },
    (args) => result(listUsers(client, args))
  );
};
