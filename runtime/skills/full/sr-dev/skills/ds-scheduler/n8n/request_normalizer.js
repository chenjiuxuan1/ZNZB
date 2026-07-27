const raw = $json.body ?? $json;

const FORBIDDEN_ACTION_ALIASES = new Set([
  'delete_project',
  'remove_project',
  'drop_project',
  'delete_workflow',
  'remove_workflow',
  'drop_workflow',
]);

const COUNTRIES = new Set(['cn', 'ine', 'mx', 'ph', 'pk', 'th']);
const ACTIONS = new Set([
  'list_projects',
  'list_workflows',
  'create_workflow',
  'list_schedules',
  'get_schedule',
  'create_schedule',
  'update_schedule',
  'online_schedule',
  'offline_schedule',
  'schedule_blast_radius',
  'get_workflow',
  'online_workflow',
  'offline_workflow',
  'trigger_workflow',
  'list_instances',
  'get_instance',
  'list_task_instances',
  'get_task_log',
  'retry_instance',
  'list_datasources',
  'get_datasource',
  'extract_task_runtime_config',
  'append_task',
  'append_sql_task',
  'append_shell_task',
  'update_task',
  'update_sql_task',
  'update_shell_task',
  'disable_tasks_except',
  'disable_task',
  'delete_task',
  'dump_workflow_graph',
]);

const source = raw.source || 'codex-skill';
const country = String(raw.country || '').trim().toLowerCase();
const action = String(raw.action || '').trim();
const ds_token = String(raw.ds_token || '').trim();
const request_id = String(raw.request_id || '').trim();
const inputPayload = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};

const payload = {
  project_code: inputPayload.project_code || '',
  workflow_code: inputPayload.workflow_code || '',
  workflow_name: inputPayload.workflow_name || '',
  description: inputPayload.description || '',
  instance_id: inputPayload.instance_id || '',
  process_instance_id: inputPayload.process_instance_id || '',
  task_instance_id: inputPayload.task_instance_id || '',
  schedule_id: inputPayload.schedule_id || '',
  start_node_list: inputPayload.start_node_list || '',
  schedule_time: inputPayload.schedule_time || '',
  state_type: inputPayload.state_type || '',
  search_val: inputPayload.search_val || '',
  page_no: inputPayload.page_no ?? 1,
  page_size: inputPayload.page_size ?? 20,
  schedule_json: inputPayload.schedule_json && typeof inputPayload.schedule_json === 'object'
    ? inputPayload.schedule_json
    : (inputPayload.schedule_json || ''),
  crontab: inputPayload.crontab || '',
  start_time: inputPayload.start_time || '',
  end_time: inputPayload.end_time || '',
  timezone_id: inputPayload.timezone_id || '',
  warning_type: inputPayload.warning_type || '',
  warning_group_id: inputPayload.warning_group_id || '',
  failure_strategy: inputPayload.failure_strategy || '',
  process_instance_priority: inputPayload.process_instance_priority || '',
  worker_group: inputPayload.worker_group || '',
  global_params: Array.isArray(inputPayload.global_params)
    ? inputPayload.global_params
    : (inputPayload.global_params && typeof inputPayload.global_params === 'object' ? inputPayload.global_params : []),
  execution_type: inputPayload.execution_type || '',
  timeout: inputPayload.timeout ?? '',
  custom_params: inputPayload.custom_params && typeof inputPayload.custom_params === 'object'
    ? inputPayload.custom_params
    : {},
  task_type: inputPayload.task_type || '',
  task_name: inputPayload.task_name || '',
  task_description: inputPayload.task_description || '',
  template_task_name: inputPayload.template_task_name || '',
  sql: inputPayload.sql || '',
  script: inputPayload.script || '',
  datasource: inputPayload.datasource || '',
  datasource_id: inputPayload.datasource_id || '',
  environment_code: inputPayload.environment_code ?? '',
  tenant_code: inputPayload.tenant_code || '',
  upstream_task_name: inputPayload.upstream_task_name || '',
  upstream_task_code: inputPayload.upstream_task_code || '',
  task_code: inputPayload.task_code || '',
  local_params: Array.isArray(inputPayload.local_params)
    ? inputPayload.local_params
    : (inputPayload.local_params && typeof inputPayload.local_params === 'object' ? inputPayload.local_params : []),
  task_local_params: Array.isArray(inputPayload.task_local_params)
    ? inputPayload.task_local_params
    : (inputPayload.task_local_params && typeof inputPayload.task_local_params === 'object' ? inputPayload.task_local_params : []),
  replace_local_params: Boolean(inputPayload.replace_local_params),
  pre_statements: Array.isArray(inputPayload.pre_statements) ? inputPayload.pre_statements : [],
  post_statements: Array.isArray(inputPayload.post_statements) ? inputPayload.post_statements : [],
  task_params_patch: inputPayload.task_params_patch && typeof inputPayload.task_params_patch === 'object'
    ? inputPayload.task_params_patch
    : {},
  title: inputPayload.title || '',
  receivers: inputPayload.receivers || '',
  receivers_cc: inputPayload.receivers_cc || '',
  show_type: inputPayload.show_type || '',
  conn_params: inputPayload.conn_params && typeof inputPayload.conn_params === 'object'
    ? inputPayload.conn_params
    : {},
  keep_task_names: Array.isArray(inputPayload.keep_task_names) ? inputPayload.keep_task_names : [],
  keep_task_codes: Array.isArray(inputPayload.keep_task_codes) ? inputPayload.keep_task_codes : [],
  target_task_name_prefixes: Array.isArray(inputPayload.target_task_name_prefixes)
    ? inputPayload.target_task_name_prefixes
    : [],
};

if (typeof inputPayload.restore_original_state === 'boolean') {
  payload.restore_original_state = inputPayload.restore_original_state;
}
if (typeof inputPayload.auto_offline === 'boolean') {
  payload.auto_offline = inputPayload.auto_offline;
}
if (Object.prototype.hasOwnProperty.call(inputPayload, 'sql_type')
  && inputPayload.sql_type !== ''
  && inputPayload.sql_type != null) {
  payload.sql_type = inputPayload.sql_type;
}
if (Object.prototype.hasOwnProperty.call(inputPayload, 'resource_list')) {
  payload.resource_list = Array.isArray(inputPayload.resource_list)
    ? inputPayload.resource_list
    : (inputPayload.resource_list && typeof inputPayload.resource_list === 'object'
      ? [inputPayload.resource_list]
      : (inputPayload.resource_list === '' || inputPayload.resource_list == null ? [] : [inputPayload.resource_list]));
}
if (Object.prototype.hasOwnProperty.call(inputPayload, 'resources')) {
  payload.resource_list = Array.isArray(inputPayload.resources)
    ? inputPayload.resources
    : (inputPayload.resources && typeof inputPayload.resources === 'object'
      ? [inputPayload.resources]
      : (inputPayload.resources === '' || inputPayload.resources == null ? [] : [inputPayload.resources]));
}
if (Object.prototype.hasOwnProperty.call(inputPayload, 'replace_resource_list')) {
  payload.replace_resource_list = Boolean(inputPayload.replace_resource_list);
}

const errors = [];

if (FORBIDDEN_ACTION_ALIASES.has(action)) {
  errors.push(`forbidden action: ${action}. deleting projects or workflows is not allowed; only delete_task is allowed`);
}

if (!COUNTRIES.has(country)) errors.push(`unsupported country: ${country}`);
if (!ACTIONS.has(action)) errors.push(`unsupported action: ${action}`);
if (!ds_token) errors.push('ds_token is required');

if (['online_workflow', 'offline_workflow', 'trigger_workflow', 'dump_workflow_graph'].includes(action) && !payload.workflow_code) {
  errors.push(`${action} requires workflow_code`);
}
if (action === 'create_workflow') {
  if (!payload.project_code) errors.push('create_workflow requires project_code');
  if (!payload.workflow_name) errors.push('create_workflow requires workflow_name');
}
if (['online_schedule', 'offline_schedule', 'schedule_blast_radius'].includes(action)) {
  if (!payload.project_code) errors.push(`${action} requires project_code`);
  if (!payload.workflow_code && !payload.schedule_id) {
    errors.push(`${action} requires workflow_code or schedule_id`);
  }
}
if (action === 'get_schedule') {
  if (!payload.project_code) errors.push('get_schedule requires project_code');
  if (!payload.workflow_code && !payload.workflow_name && !payload.schedule_id) {
    errors.push('get_schedule requires schedule_id or workflow_code or workflow_name');
  }
}
if (['create_schedule', 'update_schedule'].includes(action)) {
  if (!payload.project_code) errors.push(`${action} requires project_code`);
  if (action === 'create_schedule' && !payload.workflow_code) {
    errors.push('create_schedule requires workflow_code');
  }
  if (action === 'update_schedule' && !payload.workflow_code && !payload.schedule_id) {
    errors.push('update_schedule requires workflow_code or schedule_id');
  }
  if (!payload.schedule_json && !payload.crontab) {
    errors.push(`${action} requires schedule_json or crontab`);
  }
}
if (action === 'get_instance' && !payload.instance_id) {
  errors.push('get_instance requires instance_id');
}
if (action === 'list_task_instances') {
  if (!payload.project_code) errors.push('list_task_instances requires project_code');
  if (!payload.process_instance_id && !payload.instance_id) {
    errors.push('list_task_instances requires process_instance_id or instance_id');
  }
}
if (action === 'get_task_log') {
  if (!payload.project_code) errors.push('get_task_log requires project_code');
  if (!payload.task_instance_id) {
    const hasInstance = Boolean(payload.process_instance_id || payload.instance_id);
    const hasTaskLocator = Boolean(payload.task_name || payload.task_code);
    if (!hasInstance || !hasTaskLocator) {
      errors.push('get_task_log requires task_instance_id or (process_instance_id|instance_id) plus (task_name|task_code)');
    }
  }
}
if (action === 'retry_instance') {
  if (!payload.project_code) errors.push('retry_instance requires project_code');
  if (!payload.instance_id) errors.push('retry_instance requires instance_id');
}
if (action === 'get_workflow' && !payload.workflow_code && !payload.workflow_name) {
  errors.push('get_workflow requires workflow_code or workflow_name');
}
if (action === 'extract_task_runtime_config') {
  if (!payload.project_code) errors.push('extract_task_runtime_config requires project_code');
  if (!payload.workflow_code) errors.push('extract_task_runtime_config requires workflow_code');
  if (!payload.task_name && !payload.task_code) {
    errors.push('extract_task_runtime_config requires task_name or task_code');
  }
}
if (action === 'get_datasource' && !payload.datasource && !payload.datasource_id) {
  errors.push('get_datasource requires datasource or datasource_id');
}

if (['append_task', 'append_sql_task', 'append_shell_task'].includes(action)) {
  if (!payload.project_code) errors.push(`${action} requires project_code`);
  if (!payload.workflow_code) errors.push(`${action} requires workflow_code`);
  if (!payload.task_name) errors.push(`${action} requires task_name`);

  let taskType = payload.task_type;
  if (action === 'append_sql_task') taskType = 'SQL';
  if (action === 'append_shell_task') taskType = 'SHELL';
  taskType = String(taskType || '').trim().toUpperCase();
  payload.task_type = taskType;

  if (!taskType && action === 'append_task') {
    errors.push('append_task requires task_type');
  }
  if (taskType && !['SQL', 'SHELL'].includes(taskType)) {
    errors.push(`unsupported task_type: ${taskType}`);
  }
  if (taskType === 'SQL' && !payload.sql) {
    errors.push(`${action} requires sql for SQL task`);
  }
  if (taskType === 'SHELL' && !payload.script) {
    errors.push(`${action} requires script for SHELL task`);
  }
}

if (['update_task', 'update_sql_task', 'update_shell_task'].includes(action)) {
  if (!payload.project_code) errors.push(`${action} requires project_code`);
  if (!payload.workflow_code) errors.push(`${action} requires workflow_code`);
  if (!payload.task_name && !payload.task_code) {
    errors.push(`${action} requires task_name or task_code`);
  }
  if (action === 'update_sql_task' && !payload.sql && !payload.task_params_patch.sql && !payload.task_params_patch.rawScript) {
    errors.push('update_sql_task requires sql or task_params_patch with sql/rawScript');
  }
  if (action === 'update_shell_task' && !payload.script && !payload.task_params_patch.rawScript) {
    errors.push('update_shell_task requires script or task_params_patch.rawScript');
  }
}

if (action === 'delete_task') {
  if (!payload.project_code) errors.push('delete_task requires project_code');
  if (!payload.workflow_code) errors.push('delete_task requires workflow_code');
  if (!payload.task_name && !payload.task_code) {
    errors.push('delete_task requires task_name or task_code');
  }
}

if (action === 'disable_tasks_except') {
  if (!payload.project_code) errors.push('disable_tasks_except requires project_code');
  if (!payload.workflow_code) errors.push('disable_tasks_except requires workflow_code');
  if (!payload.keep_task_names.length && !payload.keep_task_codes.length) {
    errors.push('disable_tasks_except requires keep_task_names or keep_task_codes');
  }
}

if (action === 'disable_task') {
  if (!payload.project_code) errors.push('disable_task requires project_code');
  if (!payload.workflow_code) errors.push('disable_task requires workflow_code');
  if (!payload.task_name && !payload.task_code) {
    errors.push('disable_task requires task_name or task_code');
  }
}

const payload_json = JSON.stringify(payload);
const payload_b64 = Buffer.from(payload_json, 'utf8').toString('base64');

return [
  {
    json: {
      source,
      country,
      action,
      ds_token,
      request_id,
      payload,
      payload_json,
      payload_b64,
      valid: errors.length === 0,
      errors,
    },
  },
];
