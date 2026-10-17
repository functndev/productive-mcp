# productive-mcp — secrets template. Values live in 1Password: vault "Infra - L7", item "productive-mcp",
# one field per variable, field label = variable name.
#
#   op inject -f -i .env.tpl -o .env        # write .env for `wrangler dev`
#   op run --env-file .env.tpl -- <cmd>     # or inject into a single command without a file

# Productive org
PRODUCTIVE_ORG_ID=op://Infra - L7/productive-mcp/PRODUCTIVE_ORG_ID

# Email → { userId, apiToken, isAdmin? } as single-line JSON
USER_MAPPING='op://Infra - L7/productive-mcp/USER_MAPPING'

# Cloudflare Access SaaS app "Productive MCP" → OIDC
ACCESS_CLIENT_ID=op://Infra - L7/productive-mcp/ACCESS_CLIENT_ID
ACCESS_CLIENT_SECRET=op://Infra - L7/productive-mcp/ACCESS_CLIENT_SECRET
ACCESS_TOKEN_URL=op://Infra - L7/productive-mcp/ACCESS_TOKEN_URL
ACCESS_AUTHORIZATION_URL=op://Infra - L7/productive-mcp/ACCESS_AUTHORIZATION_URL
ACCESS_JWKS_URL=op://Infra - L7/productive-mcp/ACCESS_JWKS_URL

# Encrypts the OAuth approval cookie. openssl rand -hex 32
COOKIE_ENCRYPTION_KEY=op://Infra - L7/productive-mcp/COOKIE_ENCRYPTION_KEY
