import { z } from "zod";
import { McpError, ErrorCode } from '../errors.js';
import { ProductiveAPIClient } from "../api/client.js";
import { READ, result, type RegisterTools } from './context.js';

export const listUsersSchema = z.object({});

/**
 * List internal Productive users.
 *
 * Available to every authenticated user, but always executed against the
 * admin API token resolved from USER_MAPPING (any entry flagged
 * `isAdmin: true`). The calling user's own credentials are not used.
 */
export async function listUsers(
  client: ProductiveAPIClient,
  args: unknown,
  adminApiToken: string | undefined,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    listUsersSchema.parse(args);

    if (!adminApiToken) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'list_users requires an admin API token. Flag at least one USER_MAPPING entry with "isAdmin": true.',
      );
    }

    // Build a one-off client that uses the admin token for this single call.
    const baseConfig = client.getConfig();
    const adminClient = new ProductiveAPIClient({
      ...baseConfig,
      PRODUCTIVE_API_TOKEN: adminApiToken,
    });

    const { people, rolesById } = await adminClient.listUsers();

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

export const registerUserTools: RegisterTools = (server, { client, config }) => {
  server.registerTool(
    "list_users",
    {
      title: "List users",
      description: "List all internal users (active, login-able people; no contacts, placeholders or agents) with id, name, email and role.",
      inputSchema: listUsersSchema,
      annotations: READ,
    },
    (args) => result(listUsers(client, args, config.PRODUCTIVE_ADMIN_API_TOKEN))
  );
};
