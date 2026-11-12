# productive-mcp — secrets template. Values live in 1Password: vault "Infra - L7", item "productive-mcp",
# field label = variable name. Plain config (Access issuer and client ID) is in cloudflare.config.ts.
#
#   op inject -f -i .env.tpl -o .env        # write .env for `wrangler dev`
#   op run --env-file .env.tpl -- <cmd>     # or inject into a single command without a file

# Cloudflare Access SaaS app "Productive MCP" → OIDC client secret
ACCESS_CLIENT_SECRET=op://Infra - L7/productive-mcp/ACCESS_CLIENT_SECRET

# Encrypts attachment download links (they carry the person's ID token). openssl rand -hex 32
COOKIE_ENCRYPTION_KEY=op://Infra - L7/productive-mcp/COOKIE_ENCRYPTION_KEY
