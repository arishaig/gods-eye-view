# Self-hosting

God's Eye View is built to run on your own machine. This page covers running
it as a long-lived service instead: a container image, behind a reverse proxy
that terminates TLS and authenticates users. Read
[SECURITY.md](../SECURITY.md#network-exposure--the-operator-threat-model)
first. The server brokers every key you give it, so **anyone who can reach it
can spend your provider quotas.**

## Before you expose it

- **Put authentication in front.** Single sign-on at the proxy (for example
  Authelia, Authentik or oauth2-proxy), a VPN, or both. The app has no user
  accounts of its own.
- **Set provider-side limits.** OpenAI usage limits, Google Cloud budgets and
  per-API quotas. The app's per-client throttles are not billing caps.
- **Restrict the browser keys.** The Google Maps browser key and the Cesium
  ion token are visible to every visitor: restrict the Google key by HTTP
  referrer (`https://your-host/*`) and give the Cesium token URL restrictions.
  Restrict the server-side Google key (`GOOGLE_MAPS_SERVER_API_KEY`) to the
  Places API.

## Container image

```bash
docker build -t gods-eye-view .
docker run --rm -p 4173:4173 \
  -e GEV_ALLOWED_HOSTS=globe.example.com \
  -e GEV_TRUSTED_PROXIES=172.18.0.0/16 \
  --env-file gev.env \
  -v gev-cache:/app/.gev-cache \
  gods-eye-view
```

The image builds the app once and serves it with `vite preview`, which runs the
same provider routes as the dev server. It runs as the unprivileged `node` user
(UID 1000) and listens on `0.0.0.0:4173`.

**Keys are read at run time, not baked in.** Server-side keys are ordinary
environment variables, as in `.env.example`. The three browser keys
(`GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN`, `MAPILLARY_CLIENT_TOKEN`) reach the
page through `/gev-runtime-config.js`, which the server builds from its
environment. One image can therefore be published and run anywhere. A key set
at build time still works as a fallback.

`GEV_HOME_VIEW` sets where the globe flies on load when the URL holds no
shared view, as `lat,lon[,height_m]` (e.g. `51.5072,-0.1276,1500`; the height
defaults to 600 m). It travels through `/gev-runtime-config.js` too, so anyone
who can load the page can read it; keep it coarse if it is near home. Unset or
malformed, the app flies to Austin, TX as before.

The Provider Settings panel is development-only, so it is not available in the
image; set keys through the environment. ChatGPT OAuth voice needs a loopback
connection and is unavailable behind a proxy; use `OPENAI_API_KEY`.

`/app/.gev-cache` holds provider caches and the TomTom daily request budget.
Mount a volume there to keep them across restarts.

## Behind a reverse proxy

Two settings make the app work behind a proxy:

| Variable              | Value                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `GEV_ALLOWED_HOSTS`   | The public host name, e.g. `globe.example.com`. Without it the Host check refuses the request. |
| `GEV_TRUSTED_PROXIES` | The proxy's address or range, as the app sees it, e.g. `10.244.0.0/16` for a Kubernetes pod network. |

Without `GEV_TRUSTED_PROXIES`, the cost-bearing endpoints (voice, HUD
summaries, Google place search, Mapillary) refuse every request that carries
forwarding headers. That is the right default for a laptop, but it breaks those
features behind any proxy.

With it, a request whose **socket peer** is in the list is checked against the
origin the browser actually used (`X-Forwarded-Proto` and `X-Forwarded-Host`),
and is rate-limited by the client address the proxy reports (the rightmost
`X-Forwarded-For` hop that is not itself a trusted proxy). Requests from any
other peer are handled exactly as before, forwarding headers and all.

The proxy should:

- pass the original `Host` header through (most do by default);
- set `X-Forwarded-Proto` and `X-Forwarded-For`, overwriting any value the
  client sent.

Scope the trusted range as narrowly as your network allows. Any peer in it can
choose the client address and origin the app sees.

## MCP clients

The MCP server at `/mcp` ([MCP_SETUP.md](MCP_SETUP.md)) answers only local
requests, with or without `GEV_TRUSTED_PROXIES`: the peer must be loopback,
the Host must name a loopback host on the port the request reached, and the
request must carry no forwarding headers. To offer it to a remote client, run
your own authenticating proxy **in the same network namespace** as the app
(a sidecar container in the same pod, for example). Have it check the
client's credentials, then forward each request to
`http://127.0.0.1:4173/mcp` with `Host: localhost:4173`, passing only the
`Content-Type`, `Accept`, `MCP-Protocol-Version` and `Mcp-Session-Id`
headers. The proxy is then the only thing standing between the network and
your keys, so make it strict.

Set `GEV_PUBLIC_URL` (e.g. `https://globe.example.com`) so the links tools
return name the app's public address instead of `http://localhost:4173`.
The tools still read data from the local address. The image includes the
panel build that clients which display apps load.

## Updating

Rebuild the image from a newer checkout. Caches in `/app/.gev-cache` are safe
to keep across versions and safe to delete.
