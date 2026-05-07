import { z } from "zod";

const configSchema = z.object({
  PRODUCTIVE_API_TOKEN: z.string().min(1, "API token is required"),
  PRODUCTIVE_ORG_ID: z.string().min(1, "Organization ID is required"),
  PRODUCTIVE_USER_ID: z.string().optional(),
  PRODUCTIVE_API_BASE_URL: z
    .string()
    .url()
    .default("https://api.productive.io/api/v2/"),
  /**
   * Optional API token of a user with admin privileges. Used only by tools
   * that require elevated access (e.g. listing all users). Resolved in
   * access-handler from any USER_MAPPING entry flagged with isAdmin:true.
   */
  PRODUCTIVE_ADMIN_API_TOKEN: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(env: Record<string, unknown>): Config {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    console.error("Configuration validation failed:", result.error.format());
    throw new Error(
      "Invalid configuration. Please check your environment variables.",
    );
  }

  return result.data;
}
