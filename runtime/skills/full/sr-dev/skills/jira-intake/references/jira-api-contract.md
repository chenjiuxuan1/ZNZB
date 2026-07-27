# Jira Intake API Contract

`jira-intake` uses a Rovo-first transport model.

Use `@atlassian-rovo` as the primary Jira read/write surface when it is available. `jira-intake` consumes the resulting Jira/Rovo JSON, normalizes it, builds DW Dev artifacts, produces management statistics/classification, and records local operation plans or after-action audit evidence.

Use Jira Cloud REST API v3 only as a fallback for standalone installation, Rovo-unavailable cases, or fields/actions Rovo cannot cover.

## Transport Modes

| Transport | Purpose | Requires Jira email/token |
|---|---|---|
| `rovo` | Default. Consume Rovo output and record local artifacts/audits. | No |
| `auto` | Orchestrator may prefer Rovo and fall back to REST when needed. | Only when REST fallback is used |
| `rest` | Direct Jira Cloud REST API calls. | Yes |

`config check` validates the default local configuration without requiring a token. `config check --require-rest` and `config check --connect` validate REST fallback credentials.

## Rovo Input Normalization

Rovo search-like payloads may arrive as:

```json
{
  "issues": {
    "nodes": [],
    "pageInfo": {
      "hasNextPage": false,
      "endCursor": null
    },
    "webUrl": "https://example.atlassian.net/issues/?jql=project%20%3D%20DATA"
  }
}
```

`normalize_jira_payload` maps that into:

```json
{
  "issues": [],
  "total": 0,
  "isLast": true,
  "nextPageToken": "",
  "source_transport": "atlassian-rovo"
}
```

Single issue payloads and REST search payloads are also normalized into the same structure. Each normalized issue should carry:

```text
source_transport
id
key
fields
```

## REST Fallback Read APIs

| Need | Method |
|---|---|
| Issue details | `GET /rest/api/3/issue/{issueIdOrKey}` |
| Comments | `GET /rest/api/3/issue/{issueIdOrKey}/comment` |
| Available transitions | `GET /rest/api/3/issue/{issueIdOrKey}/transitions` |
| JQL search | `GET /rest/api/3/search/jql` |
| Field discovery | `GET /rest/api/3/field/search` |

Use explicit fields for issue reads:

```text
summary,description,status,assignee,reporter,priority,labels,components,fixVersions,created,updated,duedate,issuetype,project,parent,customfield_11541
```

Use `expand=renderedFields,names,schema,changelog` when the caller needs rendered text, custom field mapping, or change evidence.

## DATA Project Category Field

`DATA` project requirements use `数据平台Jira工单分类` as a cascading select field:

```text
field key: customfield_11541
type: option-with-child / cascadingselect
enum source: Google Sheet jira 工单分类 / 类目表 A:B
```

Write shape for Rovo `additional_fields` or REST `fields`:

```json
{
  "customfield_11541": {
    "value": "运维与稳定性",
    "child": {"value": "容量 / 资源治理"}
  }
}
```

Rules:

- Preserve an existing Jira field value when present.
- If the requester did not provide first/second category, infer the most specific controlled value from summary, description, components, labels, country, and business scenario.
- Do not submit a create/edit payload with only the first category when the second category is inferable.
- If no controlled value fits, omit `customfield_11541`, mark classification source as `unknown`, and ask for clarification before any confirmed Jira write.
- Example mapping: `DATA-2402` -> `宽表建设 / 营销主题宽表`; `DATA-2405` -> `运维与稳定性 / 容量 / 资源治理`.

For JQL search, pass explicit `maxResults` and preserve `nextPageToken` from the response when present. `jira-intake` defaults to bounded single-page reads for daily management; looping across pages should require an explicit range decision.

## Write Actions

| Need | Preferred execution surface | REST fallback method | Default |
|---|---|---|---|
| Add comment | `@atlassian-rovo` | `POST /rest/api/3/issue/{issueIdOrKey}/comment` | plan/audit only |
| Transition issue | `@atlassian-rovo` | `POST /rest/api/3/issue/{issueIdOrKey}/transitions` | plan/audit only |
| Edit issue | `@atlassian-rovo` | `PUT /rest/api/3/issue/{issueIdOrKey}` | blocked unless explicitly designed |
| Upload attachment | `@atlassian-rovo` | `POST /rest/api/3/issue/{issueIdOrKey}/attachments` | blocked unless confirmed |

Write actions require:

- target issue key;
- local source artifact path, such as `09-jira-comment.md`;
- human confirmation;
- result evidence under `06-evidence/`;
- no token or secret in persisted files.

Transition write actions additionally require:

- read available transitions before execution when using REST fallback;
- reject transition IDs not present in the current issue transition list when using REST fallback;
- record before and after issue status;
- persist result evidence when an output path is supplied.

Rovo write actions should be followed by `audit-operation` so the local workspace still keeps:

```text
source_transport=atlassian-rovo
operation
issue_key
executed=true
before
after
transition
actor
safety_boundary
```

## Daily Management Outputs

`stats` writes grouped management summaries from saved Rovo/Jira JSON or bounded REST JQL search:

```json
{
  "schema_version": "1.0.0",
  "source_transport": "atlassian-rovo",
  "summary": {
    "returned": 0,
    "jira_total": 0,
    "next_page_token": ""
  },
  "groups": {
    "status": {},
    "assignee": {},
    "jira_category": {},
    "country": {},
    "business_domain": {},
    "request_type": {}
  },
  "issues": []
}
```

Classification is heuristic and conservative. Unknown country, business domain, or request type remains `unknown` / `needs_manual_parse: true` so `$dw-dev` can ask for clarification instead of guessing.

## Output Mapping

`00-requirement.md` keeps the readable source:

```markdown
## 来源

- Source: jira
- Jira Key: DATA-2048
- Jira URL: https://example.atlassian.net/browse/DATA-2048
- Status:
- Reporter:
- Assignee:
```

`01-requirement.yaml` keeps machine-readable fields:

```yaml
ticket_id: DATA-2048
source: jira
source_url: ""
jira:
  site: ""
  issue_id: ""
  issue_key: DATA-2048
  project_key: DATA
  status: ""
  status_category: ""
jira_category:
  field_key: customfield_11541
  primary: ""
  secondary: ""
  field_value: {}
source_transport: atlassian-rovo
```
