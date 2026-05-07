type EnvMap = Record<string, string>;

const token = process.env.PRODUCTIVE_API_TOKEN;
const orgId = process.env.PRODUCTIVE_ORG_ID;
const baseUrl = "https://api.productive.io/api/v2/".replace(/\/?$/, "/");

if (!token || !orgId) {
  console.error(
    "Missing PRODUCTIVE_API_TOKEN/PRODUCTIVE_ADMIN_API_TOKEN or PRODUCTIVE_ORG_ID in .env",
  );
  process.exit(1);
}

async function main() {
  // Per OpenAPI spec (filter_person.person_type), values are
  // user (can log in), contact (external), placeholder (resource planning), agent.
  // The API rejects the string names and requires the underlying numeric IDs:
  //   1 = user, 2 = contact, 3 = placeholder, 4 = agent.
  const path =
    "people?page[size]=200&filter[hrm_type_id]=1&include=custom_role";
  const url = new URL(path, baseUrl);

  try {
    const response = await fetch(url, {
      headers: {
        "X-Auth-Token": token,
        "X-Organization-Id": orgId,
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
      },
    });

    let body: any = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    console.table([
      {
        path,
        status: response.status,
        ok: response.ok,
        detail: body?.errors?.[0]?.detail || null,
        meta: JSON.stringify(body?.meta ?? null),
        links: JSON.stringify(body?.links ?? null),
      },
    ]);

    if (Array.isArray(body?.data)) {
      const rolesById = new Map<string, string>();
      for (const inc of (body.included ?? []) as any[]) {
        if (inc?.type === "roles" && inc?.id) {
          rolesById.set(String(inc.id), inc.attributes?.name ?? "");
        }
      }

      const rows = body.data.map((item: any) => {
        const roleId = item.relationships?.custom_role?.data?.id;
        return {
          id: item.id,
          email: item.attributes?.email,
          name: [item.attributes?.first_name, item.attributes?.last_name]
            .filter(Boolean)
            .join(" "),
          role_id: roleId ?? null,
          role: roleId ? (rolesById.get(String(roleId)) ?? null) : null,
        };
      });
      console.table(rows);
      console.log(`Total users: ${body.data.length}`);
    }
  } catch (error) {
    console.table([
      {
        path,
        fetchError: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
}
main();
