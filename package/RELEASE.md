# aux4/api 2.0.10

## Fixes

### `api handle` surfaces the API Gateway authorizer identity as the route command's principal

When an api app is fronted by an API Gateway custom authorizer (for example the
aux4.cloud SSO authorizer), the authorizer validates the caller at the edge and
passes the authenticated identity in `event.requestContext.authorizer`. Until now
`api handle` dropped it — the request was rebuilt internally and the identity
never reached the route command.

`api handle` now carries `requestContext.authorizer` onto the synthetic request
and forwards it to the route command as `--principal`, so the command knows who
called (matching how command-type deployments receive the caller's identity).
Requests without an authorizer are unaffected.
