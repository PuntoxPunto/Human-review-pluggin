# M4 acceptance checklist

- [ ] MCP server reports version 0.5.0.
- [ ] Web Review cockpit resource is `ui://widget/web-review/v2.html`.
- [ ] `set_web_finding_decision` is app-private and widget-accessible.
- [ ] `get_web_findings` is model-visible.
- [ ] Accept/reject/reset decisions are persisted outside immutable evidence.
- [ ] Finding comments survive deterministic reanalysis.
- [ ] Fingerprints survive description/metric changes for the same DOM target identity.
- [ ] Human Review direct-edit conflict protection remains green.
- [ ] Real Chromium capture remains green.
- [ ] External AppDeploy MCP probe remains green.
