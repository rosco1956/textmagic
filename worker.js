// JotForm → TextMagic contact sync
// Handles individual, couple and family intake forms.

const TM_BASE = "https://rest.textmagic.com/api/v2";

// Register your couple and family forms here, keyed by JotForm form ID
// (the long number in the form's URL: jotform.com/build/<FORM_ID>).
// Any form ID NOT listed here is treated as an individual intake form,
// exactly as the Worker worked before.
//
//   people:       field-name prefixes for each adult (see naming rules below)
//   children:     how many child sections the form has (family forms only)
//   childrenNote: set to false to ignore children entirely and keep
//                 their details out of TextMagic
const FORMS = {
    const FORMS = {
  "https://form.jotform.com/263006795316358": { label: "Individual", people: ["client"] },
};

  // Couple form where each partner fills in their own copy (one person per submission):
  // "REPLACE_WITH_COUPLE_FORM_ID": {
  //   label: "Couple",
  //   people: ["client"],
  // },
  // (For one combined form with both partners on it, use people: ["partner1", "partner2"].)
  // "REPLACE_WITH_FAMILY_FORM_ID": {
  //   label: "Family",
  //   people: ["parent1", "parent2"],
  //   children: 8,
  //   childrenNote: true,
  // },

// FIELD NAMING (set under each field's Properties → Advanced → Unique Name in JotForm)
//   <prefix>First, <prefix>Last   or a single <prefix>Name (Full Name widget)
//   <prefix>Phone, <prefix>Email
//   e.g. partner1First, partner1Last, partner1Phone, partner1Email
// Optional hidden field named householdRef: if present, its value is added to each
// contact's note, so two people who got the same link can be matched up.
// Optional field named sharedResponsibility (Yes / No / Not sure): if present, the
// answer is added to the note.
// Children use child1, child2, ... as prefixes:
//   child1First, child1Last (or child1Name), child1Dob  (Birth Date widget)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("JotForm→Textmagic Worker is running ✓", { status: 200 });
    }

    if (env.WEBHOOK_SECRET) {
      const token = request.headers.get("x-jotform-signature") || url.searchParams.get("secret");
      if (token !== env.WEBHOOK_SECRET) {
        return json({ error: "Unauthorised" }, 401);
      }
    }

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

    const countryCode = env.DEFAULT_COUNTRY_CODE || "44";
    const formId = String(formData.get("formID") || "");
    const config = FORMS[formId];

    // Logs field names only (not values) so client details stay out of the logs.
    // Use `wrangler tail` to see these when testing a new form.
    console.log(
      `Submission received: form ${formId}, type ${config ? config.label : "Individual"}, fields: ${Object.keys(submission).join(", ")}`
    );

    if (!config) {
      return handleIndividual(submission, env, countryCode);
    }
    return handleHousehold(submission, config, formData.get("submissionID"), env, countryCode);
  },
};

// ---------- Individual form (original behaviour) ----------

async function handleIndividual(submission, env, countryCode) {
  const client = extractClient(submission);

  if (!client.phone) {
    return json({ error: "No phone number found — cannot create contact" }, 400);
  }

  client.phone = normalisePhone(client.phone, countryCode);
  const result = await upsertContact(client, env);
  return json(result, result.success ? 200 : 500);
}

function extractClient(data) {
  function find(hints) {
    for (const hint of hints) {
      for (const [key, val] of Object.entries(data)) {
        if (key.toLowerCase().includes(hint.toLowerCase())) {
          if (val && typeof val === "object") {
            return Object.values(val).filter(Boolean).join(" ").trim();
          }
          if (val) return String(val).trim();
        }
      }
    }
    return "";
  }

  const fullName = find(["fullName", "name", "firstName"]);
  const nameParts = fullName.split(" ").filter(Boolean);

  return {
    firstName: find(["firstName", "first_name"]) || nameParts[0] || "",
    lastName: find(["lastName", "last_name"]) || nameParts.slice(1).join(" ") || "",
    phone: find(["phone", "mobile", "telephone", "cell"]),
    email: find(["email"]),
    companyName: find(["company", "business", "organisation", "organization"]),
  };
}

// ---------- Couple / family forms ----------

async function handleHousehold(submission, config, submissionId, env, countryCode) {
  const people = config.people
    .map((prefix) => extractPerson(submission, prefix))
    .filter((p) => p.firstName || p.lastName || p.phone);

  if (people.length === 0) {
    return json({ error: "No people found in submission — check the field names" }, 400);
  }

  const householdRef = getHouseholdRef(submission);
  const sharedResponsibility = getNamedField(submission, "sharedResponsibility");
  const keepChildren = config.childrenNote !== false;
  const children = keepChildren && config.children ? extractChildren(submission, config.children) : [];

  const results = [];
  const seenPhones = new Set();
  let childrenNoted = false;

  for (const person of people) {
    const name = displayName(person);

    if (!person.phone) {
      results.push({ name, skipped: true, reason: "No phone number" });
      continue;
    }

    person.phone = normalisePhone(person.phone, countryCode);

    // If two people share one number, don't let the second overwrite the first
    if (seenPhones.has(person.phone)) {
      results.push({ name, skipped: true, reason: "Same phone number as another person on this form" });
      continue;
    }
    seenPhones.add(person.phone);

    const result = await upsertContact(person, env);

    if (result.success) {
      // Children's details go on the first adult who was successfully synced
      const includeChildren = children.length > 0 && !childrenNoted;
      const note = buildNote(config.label, submissionId, person, people, includeChildren ? children : [], householdRef, sharedResponsibility);
      result.noteAdded = await addNote(result.id, note, env);
      if (includeChildren && result.noteAdded) childrenNoted = true;
    }

    results.push(result);
  }

  const synced = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success && !r.skipped);
  const ok = synced.length > 0 && failed.length === 0;
  const status = ok ? 200 : failed.length > 0 ? 500 : 400;

  return json({ success: ok, results }, status);
}

// Finds a field whose name (after JotForm's "q<number>_" prefix) starts with
// the person's prefix followed by one of the hints, e.g. partner1 + "phone".
function getField(data, prefix, hints) {
  const p = prefix.toLowerCase();
  for (const hint of hints) {
    for (const [key, val] of Object.entries(data)) {
      const k = key.toLowerCase().replace(/^q\d+_/, "");
      if (!k.startsWith(p)) continue;
      const rest = k.slice(p.length).replace(/^_/, "");
      if (rest.startsWith(hint.toLowerCase())) return val;
    }
  }
  return undefined;
}

function toText(val) {
  if (!val) return "";
  if (typeof val === "object") return Object.values(val).filter(Boolean).join(" ").trim();
  return String(val).trim();
}

function extractName(data, prefix) {
  const first = toText(getField(data, prefix, ["first"]));
  const last = toText(getField(data, prefix, ["last"]));
  const parts = toText(getField(data, prefix, ["name"])).split(" ").filter(Boolean);
  return {
    firstName: first || parts[0] || "",
    lastName: last || parts.slice(1).join(" ") || "",
  };
}

function extractPerson(data, prefix) {
  return {
    ...extractName(data, prefix),
    phone: toText(getField(data, prefix, ["phone", "mobile"])),
    email: toText(getField(data, prefix, ["email"])),
  };
}

function extractChildren(data, max) {
  const kids = [];
  for (let i = 1; i <= max; i++) {
    const prefix = `child${i}`;
    const name = displayName(extractName(data, prefix));
    const dob = formatDob(getField(data, prefix, ["dob", "birth"]));
    if (name || dob) kids.push({ name, dob });
  }
  return kids;
}

function formatDob(val) {
  if (!val) return "";
  if (typeof val === "object") {
    const { day, month, year } = val;
    if (day && month && year) {
      return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
    }
    return toText(val);
  }
  return String(val).trim();
}

// Reads the hidden "householdRef" field that JotForm fills in from the form link
// (e.g. ...?householdRef=C-2026-014). Returns "" if the field is missing or empty.
function getHouseholdRef(data) {
  return getNamedField(data, "householdRef");
}

// Reads a field by its exact Unique Name (ignoring JotForm's "q<number>_" prefix
// and capitalisation). Returns "" if the field is missing or empty.
function getNamedField(data, name) {
  const target = name.toLowerCase();
  for (const [key, val] of Object.entries(data)) {
    if (key.toLowerCase().replace(/^q\d+_/, "") === target) {
      return toText(val);
    }
  }
  return "";
}

function displayName(p) {
  return `${p.firstName || ""} ${p.lastName || ""}`.trim();
}

function buildNote(label, submissionId, person, people, children, householdRef, sharedResponsibility) {
  const lines = [`${label} intake form${submissionId ? ` (JotForm submission ${submissionId})` : ""}.`];
  if (householdRef) lines.push(`Household reference: ${householdRef}.`);
  if (sharedResponsibility) {
    lines.push(`Other parent/guardian shares parental responsibility: ${sharedResponsibility}.`);
  }

  const others = people.filter((p) => p !== person).map(displayName).filter(Boolean);
  if (others.length) lines.push(`Also on this form: ${others.join(", ")}.`);

  if (children.length) {
    const kids = children.map((c) => (c.dob ? `${c.name || "Unnamed"} (DOB ${c.dob})` : c.name));
    lines.push(`Children: ${kids.join("; ")}.`);
  }

  return lines.join("\n");
}

async function addNote(contactId, note, env) {
  const resp = await fetch(`${TM_BASE}/contacts/${contactId}/notes`, {
    method: "POST",
    headers: authHeaders(env),
    body: JSON.stringify({ note }),
  });
  if (resp.ok) return true;

  console.error(`⚠️ Note failed (${resp.status}): ${await resp.text()}`);
  return false;
}

// ---------- TextMagic contact create / update (unchanged logic) ----------

function authHeaders(env) {
  const auth = btoa(`${env.TEXTMAGIC_USERNAME}:${env.TEXTMAGIC_API_KEY}`);
  return {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
  };
}

async function upsertContact(client, env) {
  const headers = authHeaders(env);

  const searchResp = await fetch(
    `${TM_BASE}/contacts?search=${encodeURIComponent(client.phone)}&limit=5`,
    { headers }
  );

  if (!searchResp.ok) {
    const err = await searchResp.text();
    return { success: false, error: `Textmagic search failed: ${err}` };
  }

  const searchData = await searchResp.json();
  const existing = (searchData.resources || []).find(
    (c) => normalisePhone(c.phone || "", env.DEFAULT_COUNTRY_CODE || "44") === client.phone
  );

  const payload = {
    phone: client.phone,
    firstName: client.firstName,
    lastName: client.lastName,
    ...(client.email && { email: client.email }),
    ...(client.companyName && { companyName: client.companyName }),
  };

  if (existing) {
    return await updateContact(existing.id, payload, headers, client);
  }
  return await createContact(payload, headers, client);
}

async function createContact(payload, headers, client) {
  const resp = await fetch(`${TM_BASE}/contacts`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (resp.status === 200 || resp.status === 201) {
    const data = await resp.json();
    const name = displayName(client);
    console.log(`✅ Contact CREATED: ${name} (${client.phone}) — ID ${data.id}`);
    return { success: true, action: "created", id: data.id, name };
  }

  const err = await resp.text();
  console.error(`❌ Create failed (${resp.status}): ${err}`);
  return { success: false, action: "create_failed", error: err };
}

async function updateContact(id, payload, headers, client) {
  const resp = await fetch(`${TM_BASE}/contacts/${id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload),
  });

  if (resp.status === 200 || resp.status === 201 || resp.status === 204) {
    const name = displayName(client);
    console.log(`🔄 Contact UPDATED: ${name} (${client.phone}) — ID ${id}`);
    return { success: true, action: "updated", id, name };
  }

  const err = await resp.text();
  console.error(`❌ Update failed (${resp.status}): ${err}`);
  return { success: false, action: "update_failed", error: err };
}

function normalisePhone(phone, countryCode = "44") {
  let digits = phone.replace(/\D/g, "");
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
