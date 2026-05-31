/**
 * JotForm → Textmagic Contact Sync
 * Cloudflare Worker
 * ─────────────────────────────────
 * Receives a JotForm webhook POST, extracts client details,
 * and creates or updates them as a contact in Textmagic.
 *
 * Environment variables (set via Cloudflare dashboard or wrangler secret):
 *   TEXTMAGIC_USERNAME   — your Textmagic username
 *   TEXTMAGIC_API_KEY    — your Textmagic API key
 *   DEFAULT_COUNTRY_CODE — e.g. 44 for UK (default: 44)
 *   WEBHOOK_SECRET       — optional: a secret token to verify JotForm requests
 */

const TM_BASE = "https://rest.textmagic.com/api/v2";

// ── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {

    // Only accept POST to /webhook
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("JotForm→Textmagic Worker is running ✓", { status: 200 });
    }

    // Optional: verify webhook secret
    if (env.WEBHOOK_SECRET) {
      const token = request.headers.get("x-jotform-signature") || url.searchParams.get("secret");
      if (token !== env.WEBHOOK_SECRET) {
        return json({ error: "Unauthorised" }, 401);
      }
    }

    // ── 1. Parse JotForm payload ────────────────────────────────────────────
    let formData;
    try {
      formData = await request.formData();
    } catch {
      return json({ error: "Could not parse form data" }, 400);
    }

    const raw = formData.get("rawRequest");
    if (!raw) return json({ error: "Missing rawRequest field" }, 400);

    let submission;
    try {
      submission = JSON.parse(raw);
    } catch {
      return json({ error: "Could not parse rawRequest JSON" }, 400);
    }

    // ── 2. Extract client fields ────────────────────────────────────────────
    const client = extractClient(submission);
    console.log("New submission:", JSON.stringify(client));

    if (!client.phone) {
      return json({ error: "No phone number found — cannot create contact" }, 400);
    }

    // ── 3. Normalise phone ──────────────────────────────────────────────────
    const countryCode = env.DEFAULT_COUNTRY_CODE || "44";
    client.phone = normalisePhone(client.phone, countryCode);

    // ── 4. Create / update contact in Textmagic ─────────────────────────────
    const result = await upsertContact(client, env);
    return json(result, result.success ? 200 : 500);
  }
};


// ── Extract client from JotForm submission ───────────────────────────────────

function extractClient(data) {
  /**
   * JotForm field keys look like: q3_fullName, q4_email, q5_phoneNumber
   * find() does a case-insensitive substring match so it works even if
   * your field names differ slightly. Add extra hints if needed.
   */
  function find(hints) {
    for (const hint of hints) {
      for (const [key, val] of Object.entries(data)) {
        if (key.toLowerCase().includes(hint.toLowerCase())) {
          if (val && typeof val === "object") {
            // JotForm sometimes sends name as { first: "...", last: "..." }
            return Object.values(val).filter(Boolean).join(" ").trim();
          }
          if (val) return String(val).trim();
        }
      }
    }
    return "";
  }

  const fullName  = find(["fullName", "name", "firstName"]);
  const nameParts = fullName.split(" ").filter(Boolean);

  return {
    firstName:   find(["firstName", "first_name"]) || nameParts[0]         || "",
    lastName:    find(["lastName",  "last_name"])  || nameParts.slice(1).join(" ") || "",
    phone:       find(["phone", "mobile", "telephone", "cell"]),
    email:       find(["email"]),
    companyName: find(["company", "business", "organisation", "organization"]),
  };
}


// ── Textmagic upsert ──────────────────────────────────────────────────────────

async function upsertContact(client, env) {
  const auth = btoa(`${env.TEXTMAGIC_USERNAME}:${env.TEXTMAGIC_API_KEY}`);
  const headers = {
    "Authorization": `Basic ${auth}`,
    "Content-Type":  "application/json",
  };

  // 1. Search for existing contact by phone number
  const searchResp = await fetch(
    `${TM_BASE}/contacts?search=${encodeURIComponent(client.phone)}&limit=5`,
    { headers }
  );

  if (!searchResp.ok) {
    const err = await searchResp.text();
    return { success: false, error: `Textmagic search failed: ${err}` };
  }

  const searchData = await searchResp.json();
  const existing = (searchData.resources || []).find(c =>
    normalisePhone(c.phone || "", env.DEFAULT_COUNTRY_CODE || "44") === client.phone
  );

  // 2. Build the contact payload
  const payload = {
    phone:     client.phone,
    firstName: client.firstName,
    lastName:  client.lastName,
    ...(client.email       && { email:       client.email }),
    ...(client.companyName && { companyName: client.companyName }),
  };

  // 3. Update if found, create if not
  if (existing) {
    return await updateContact(existing.id, payload, headers, client);
  } else {
    return await createContact(payload, headers, client);
  }
}

async function createContact(payload, headers, client) {
  const resp = await fetch(`${TM_BASE}/contacts`, {
    method:  "POST",
    headers,
    body:    JSON.stringify(payload),
  });

  if (resp.status === 200 || resp.status === 201) {
    const data = await resp.json();
    const name = `${client.firstName} ${client.lastName}`.trim();
    console.log(`✅ Contact CREATED: ${name} (${client.phone}) — ID ${data.id}`);
    return { success: true, action: "created", id: data.id, name };
  }

  const err = await resp.text();
  console.error(`❌ Create failed (${resp.status}): ${err}`);
  return { success: false, action: "create_failed", error: err };
}

async function updateContact(id, payload, headers, client) {
  const resp = await fetch(`${TM_BASE}/contacts/${id}`, {
    method:  "PUT",
    headers,
    body:    JSON.stringify(payload),
  });

  if (resp.status === 200 || resp.status === 201 || resp.status === 204) {
    const name = `${client.firstName} ${client.lastName}`.trim();
    console.log(`🔄 Contact UPDATED: ${name} (${client.phone}) — ID ${id}`);
    return { success: true, action: "updated", id, name };
  }

  const err = await resp.text();
  console.error(`❌ Update failed (${resp.status}): ${err}`);
  return { success: false, action: "update_failed", error: err };
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function normalisePhone(phone, countryCode = "44") {
  let digits = phone.replace(/\D/g, "");             // strip non-digits
  if (!digits) return "";
  if (digits.startsWith("0")) digits = countryCode + digits.slice(1);
  if (!digits.startsWith(countryCode)) digits = countryCode + digits;
  return digits;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
