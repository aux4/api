# aux4/api 2.0.14

## Fixes

### `api lambda` routes on the `{proxy+}` capture, so custom-domain base paths work

When an `api lambda` function is fronted by an API Gateway **custom domain with a
base-path mapping** (e.g. `https://<host>/<basepath>/api/hello`), `event.path`
still contains the base path (`/<basepath>/api/hello`) — API Gateway does not strip
it. Routing on `event.path` therefore 404'd every request through the custom domain.

`api lambda` now routes on `event.pathParameters.proxy` (the `{proxy+}` greedy
capture), which is the path **after** both base-path and stage stripping
(`api/hello`) — identical for the raw `execute-api` URL and the custom domain. It
falls back to `event.path` when there is no proxy parameter (e.g. the root resource
or non-API-Gateway events), so existing behavior is unchanged.
