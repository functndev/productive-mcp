# productive-mcp — secrets template. Values live in 1Password: vault "Infra - L7", item "productive-mcp",
# field label = variable name. The item also holds the plain config (org ID, Access client ID and
# endpoints) for reference; the Worker reads those from `wrangler.jsonc` vars.
#
#   op inject -f -i .env.tpl -o .env        # write .env for `wrangler dev`
#   op run --env-file .env.tpl -- <cmd>     # or inject into a single command without a file

# Email → { userId, apiToken, isAdmin? } as single-line JSON
USER_MAPPING='op://Infra - L7/productive-mcp/USER_MAPPING'

# Cloudflare Access SaaS app "Productive MCP" → OIDC client secret
ACCESS_CLIENT_SECRET=op://Infra - L7/productive-mcp/ACCESS_CLIENT_SECRET

# Encrypts the OAuth approval cookie. openssl rand -hex 32
COOKIE_ENCRYPTION_KEY=op://Infra - L7/productive-mcp/COOKIE_ENCRYPTION_KEY
