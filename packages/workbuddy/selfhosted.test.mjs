// An enterprise self-hosted server asked with WorkBuddy's own client,
// wholesale: the official browser sign-in flow — and the official headers
// everywhere — against the server the user named, its address kept by the
// account so chats, models, refresh and usage go there too. An experiment:
// whether a Cloud-Hosted server takes the SaaS client.
import { afterEach, expect, test } from "bun:test"
import { WorkBuddyAuthPlugin, WorkBuddyEnterpriseAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.renewing.clear()
  _internal.renewed.clear()
})

const site = _internal.SITES["workbuddy-enterprise"]
const SERVER = "https://codebuddy.example.com"
const later = () => Date.now() + 3600_000
const ok = (data) => new Response(JSON.stringify({ code: 0, msg: "ok", data }))
const account = (over = {}) => ({
  type: "oauth", access: "a", refresh: "r", expires: later(), uid: "u",
  selfHosted: true, endpoint: SERVER, enterpriseId: "ent-1", ...over,
})

// serve answers the official sign-in flow (the state, the token — pending
// once, as 11217 — and the account) and whatever paths over stands in for,
// recording every call; anything else reads as a chat that went through.
function serve(over = {}) {
  const calls = []
  let pending = true
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    calls.push({ url: u, headers: new Headers(init?.headers), body: init?.body })
    if (over[u.pathname]) return over[u.pathname]()
    if (u.pathname === "/v2/plugin/auth/state") return ok({ state: "s", authUrl: "https://sso.example.com/login" })
    if (u.pathname === "/v2/plugin/auth/token") {
      if (pending) {
        pending = false
        return new Response(JSON.stringify({ code: 11217, msg: "login ing..." }))
      }
      return ok({ accessToken: "a", refreshToken: "r", expiresIn: 3600, domain: "codebuddy.example.com" })
    }
    if (u.pathname === "/v2/plugin/login/account") return ok({ uid: "u", nickname: "n", type: "enterprise" })
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
  return calls
}

test("the enterprise sign-in is the official browser flow, at the server named", async () => {
  const calls = serve()
  const flow = await _internal.enterpriseSignIn(site, { endpoint: SERVER + "/", enterpriseId: "ent-1" })
  // the official flow opens the page with its own version and session id
  expect(flow.url).toStartWith("https://sso.example.com/login?")
  expect(flow.url).toContain("version=2.0.0")
  expect(flow.url).toContain("loginSessionId=")
  expect(flow.method).toBe("auto")
  const result = await flow.callback()
  expect(result.type).toBe("success")
  expect(result.selfHosted).toBe(true)
  expect(result.endpoint).toBe(SERVER) // the trailing / is dropped
  expect(result.enterpriseId).toBe("ent-1")
  expect(result.uid).toBe("u")
  expect(result.accountId).toBe("n")
  // every step of the flow went to the server named, with the official
  // client's headers
  const state = calls.find((c) => c.url.pathname === "/v2/plugin/auth/state")
  expect(state.url.origin).toBe(SERVER)
  expect(state.url.searchParams.get("platform")).toBe("VSCode")
  expect(state.headers.get("X-No-Authorization")).toBe("true")
  expect(state.headers.get("X-No-Enterprise-Id")).toBe("true")
  expect(state.headers.get("X-No-Department-Info")).toBe("true")
  expect(state.headers.get("User-Agent")).toBe("WorkBuddy/5.5.6")
  expect(state.headers.get("X-Product")).toBe(null)
  expect(state.headers.get("X-Enterprise-Id")).toBe(null)
  const tok = calls.find((c) => c.url.pathname === "/v2/plugin/auth/token")
  expect(tok.headers.get("User-Agent")).toBe("WorkBuddy/5.5.6")
  const acct = calls.find((c) => c.url.pathname === "/v2/plugin/login/account")
  expect(acct.headers.get("X-Domain")).toBe("codebuddy.example.com")
  // the enterprise named at sign-in stands: the account list isn't asked
  expect(calls.some((c) => c.url.pathname === "/v2/plugin/accounts")).toBe(false)
})

test("a bad server address or empty enterprise id is refused before any request", async () => {
  await expect(_internal.enterpriseSignIn(site, { endpoint: "http://insecure.example.com", enterpriseId: "ent-1" })).rejects.toThrow("https")
  await expect(_internal.enterpriseSignIn(site, { endpoint: SERVER, enterpriseId: " " })).rejects.toThrow("enterprise id")
})

test("the provider is declared with no fixed API of its own", async () => {
  const config = {}
  const hooks = await WorkBuddyEnterpriseAuthPlugin({ client: {} })
  await hooks.config(config)
  const p = config.provider["workbuddy-enterprise"]
  expect(p.name).toBe("WorkBuddy Enterprise")
  expect(p.npm).toBe("@ai-sdk/openai-compatible")
  expect(p.api).toBeUndefined()
  expect(Object.keys(p.models).length).toBeGreaterThan(0)
})

test("the enterprise plugin offers one sign-in; the official builds keep theirs", async () => {
  const hooks = await WorkBuddyEnterpriseAuthPlugin({ client: {} })
  expect(hooks.auth.provider).toBe("workbuddy-enterprise")
  expect(hooks.auth.methods.length).toBe(1)
  const m = hooks.auth.methods[0]
  expect(m.type).toBe("oauth")
  expect(m.prompts.map((p) => p.key)).toEqual(["endpoint", "enterpriseId"])
  expect(m.prompts[0].validate("https://x.example.com")).toBeUndefined()
  expect(m.prompts[0].validate("http://x.example.com")).toBeTruthy()
  expect(m.prompts[1].validate("ent-1")).toBeUndefined()
  expect(m.prompts[1].validate("  ")).toBeTruthy()
  const official = await WorkBuddyAuthPlugin({ client: {} })
  expect(official.auth.methods.length).toBe(2)
})

test("a self-hosted account's chats go to its server with the official headers", async () => {
  const calls = serve()
  const hooks = await WorkBuddyEnterpriseAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => account())
  expect(opts.baseURL).toBe(SERVER + "/v2")
  await opts.fetch(SERVER + "/v2/chat/completions", { method: "POST", body: '{"messages":[]}' })
  const chat = calls.find((c) => c.url.pathname === "/v2/chat/completions")
  expect(chat.url.origin).toBe(SERVER)
  expect(chat.headers.get("Authorization")).toBe("Bearer a")
  expect(chat.headers.get("X-User-Id")).toBe("u")
  expect(chat.headers.get("X-Domain")).toBe("codebuddy.example.com")
  // WorkBuddy's own client headers, as the official builds' chats carry
  expect(chat.headers.get("X-Product")).toBe("SaaS")
  expect(chat.headers.get("X-IDE-Type")).toBe("WorkBuddy")
  expect(chat.headers.get("X-IDE-Name")).toBe("WorkBuddy")
  expect(chat.headers.get("User-Agent")).toBe("WorkBuddy/5.5.6")
  expect(chat.headers.get("X-Agent-Purpose")).toBe("conversation")
  // the team account is still named, as the official client does
  expect(chat.headers.get("X-Enterprise-Id")).toBe("ent-1")
  expect(chat.headers.get("X-Tenant-Id")).toBe("ent-1")
  expect(chat.headers.has("X-Conversation-Message-ID")).toBe(true)
})

test("a stale self-hosted token refreshes at its own server", async () => {
  const calls = serve({ "/v2/plugin/auth/token/refresh": () => ok({ accessToken: "a2", refreshToken: "r2", expiresIn: 3600 }) })
  const hooks = await WorkBuddyEnterpriseAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => account({ expires: Date.now() - 1000 }))
  await opts.fetch(SERVER + "/v2/chat/completions", { method: "POST", body: "{}" })
  const r = calls.find((c) => c.url.pathname === "/v2/plugin/auth/token/refresh")
  expect(r.url.origin).toBe(SERVER)
  expect(r.headers.get("X-Refresh-Token")).toBe("r")
  expect(r.headers.get("X-Enterprise-Id")).toBe("ent-1")
  expect(r.headers.get("User-Agent")).toBe("WorkBuddy/5.5.6")
  const chat = calls.find((c) => c.url.pathname === "/v2/chat/completions")
  expect(chat.headers.get("Authorization")).toBe("Bearer a2")
})

// the account's credits are the enterprise meter's, the one WorkBuddy's
// usage page reads for a team account — asked with the uid and the
// enterprise named in the body, as the self-hosted client asks them
test("a self-hosted account's usage is the enterprise meter's, at its server", async () => {
  const calls = serve({
    "/billing/meter/get-enterprise-user-usage": () => ok({
      credit: "40", limitNum: "100",
      cycleStartTime: "2026-10-01 00:00:00", cycleResetTime: "2026-11-01 00:00:00",
    }),
  })
  const hooks = await WorkBuddyEnterpriseAuthPlugin({ client: {} })
  const out = await hooks.auth.usage(async () => account())
  expect(out.signIn).toBe("kept")
  expect(out.plan).toBe("Enterprise")
  expect(out.windows[0].display).toBe("40 / 100")
  expect(out.windows[0].resetsAt).toBe(new Date(Date.parse("2026-11-01T00:00:00+08:00")).toISOString())
  expect(out.windows[0].span).toBe(31 * 24 * 3600)
  const ent = calls.find((c) => c.url.pathname === "/billing/meter/get-enterprise-user-usage")
  expect(ent.url.origin).toBe(SERVER)
  expect(JSON.parse(ent.body)).toEqual({ uid: "u", enterpriseId: "ent-1" })
  expect(ent.headers.get("X-Enterprise-Id")).toBe("ent-1")
  expect(ent.headers.get("X-Product")).toBe("SaaS")
  expect(ent.headers.get("User-Agent")).toBe("WorkBuddy/5.5.6")
  // the SaaS summary isn't asked: the self-hosted server has none
  expect(calls.some((c) => c.url.pathname === "/billing/meter/get-user-resource-summary")).toBe(false)
})

test("a server that serves no billing leaves the usage card an error", async () => {
  const calls = serve({ "/billing/meter/get-enterprise-user-usage": () => new Response("busy", { status: 502 }) })
  const hooks = await WorkBuddyEnterpriseAuthPlugin({ client: {} })
  const out = await hooks.auth.usage(async () => account())
  expect(out.error).toBeTruthy()
  expect(out.signIn).toBe("kept")
  expect(calls.some((c) => c.url.pathname === "/billing/meter/get-enterprise-user-usage")).toBe(true)
})

// the enterprise provider's icon is the one magpie's own WorkBuddy
// providers show (workbuddy-color, picked out of the magpie app itself),
// given as package.json's magpie.icon: magpie's built-in table doesn't
// know the new provider id, so the plugin says the picture itself, and
// host.js's iconOf takes package.json's for a provider whose auth hook
// says none. A data URI, so nothing is fetched.
test("the package gives the enterprise provider WorkBuddy's own icon", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(pkg.magpie.icon).toStartWith("data:image/svg+xml;base64,")
  const svg = Buffer.from(pkg.magpie.icon.slice("data:image/svg+xml;base64,".length), "base64").toString()
  expect(svg).toStartWith("<svg")
  // workbuddy-color: the teal-green gradient square, WorkBuddy's white
  // mascot on it
  expect(svg).toContain("#0EC7A8")
  expect(svg).toContain("#00C885")
  expect(svg.length).toBeLessThan(1024 * 1024)
})
