# Examples

## 1. 查询中国工作流列表

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country cn \
  --action list_workflows \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 158514956085248 \
  --page-no 1 \
  --page-size 20
```

## 2. 查询墨西哥工作流 DAG 结构

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country mx \
  --action dump_workflow_graph \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 19427088052704 \
  --workflow-code 174599383687393
```

## 3. 触发中国工作流

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country cn \
  --action trigger_workflow \
  --ds-token "YOUR_DS_TOKEN" \
  --workflow-code 158515019593728 \
  --custom-params-json '{"dt":"2026-06-10"}'
```

## 4. 在空项目里创建一个空 workflow

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country mx \
  --action create_workflow \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 177096834343936 \
  --workflow-name "codex_mx_empty_test_workflow" \
  --description "Created by Codex for DS scheduler skill testing"
```

## 5. 追加 SQL 任务

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country mx \
  --action append_task \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 19427088052704 \
  --workflow-code 174599383687393 \
  --task-type SQL \
  --task-name "测试2" \
  --template-task-name "dwd_okr_dashboard_wide_app" \
  --sql "select 2" \
  --sql-type query
```

## 6. 追加 SHELL 任务

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country mx \
  --action append_task \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 19427088052704 \
  --workflow-code 174599383687393 \
  --task-type SHELL \
  --task-name "测试shell" \
  --template-task-name "现有SHELL模板任务名" \
  --script "echo hello"
```

## 7. 查询实例详情

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country pk \
  --action get_instance \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 158514956085248 \
  --instance-id 1040772
```

## 8. 查询某次实例里的任务明细

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country mx \
  --action list_task_instances \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 19427088052704 \
  --instance-id 23511030 \
  --page-no 1 \
  --page-size 100
```

## 9. 拉取任务运行日志

按任务实例 ID 直接拉取：

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country mx \
  --action get_task_log \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 19427088052704 \
  --task-instance-id 23458667
```

按“实例 + 任务名”自动定位后拉取：

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country mx \
  --action get_task_log \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 19427088052704 \
  --instance-id 23511030 \
  --task-name "ods_repay_asset"
```

## 10. 修改已有 SQL 任务内容

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country mx \
  --action update_sql_task \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 19427088052704 \
  --workflow-code 174599383687393 \
  --task-name "dwd_okr_dashboard_wide_app" \
  --sql "select 2" \
  --sql-type query
```

## 11. 给任务添加自定义参数

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country mx \
  --action update_task \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 19427088052704 \
  --workflow-code 174599383687393 \
  --task-name "dwd_okr_dashboard_wide_app" \
  --task-local-params-json '[{"prop":"biz_date","direct":"IN","type":"VARCHAR","value":"${system.biz.date}"}]'
```

## 12. 给任务填写资源列表

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country mx \
  --action update_shell_task \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 19427088052704 \
  --workflow-code 174599383687393 \
  --task-name "load_dim_account_shell" \
  --resource-list-json '[{"id":12345,"name":"ods/load_dim_account.sh","res":"FILE"}]'
```

如需保留原资源再追加新资源，可额外加：

```bash
--merge-resource-list
```

## 13. 修改已有 SHELL 任务脚本

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country mx \
  --action update_shell_task \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 19427088052704 \
  --workflow-code 174599383687393 \
  --task-name "load_dim_account_shell" \
  --script "bash /data/apps/ds/load_dim_account.sh ${biz_date}"
```

## 14. 创建定时

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country cn \
  --action create_schedule \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 158514956085248 \
  --workflow-code 158515019593728 \
  --crontab "0 0 3 * * ? *" \
  --start-time "2026-06-25 03:00:00" \
  --failure-strategy CONTINUE \
  --process-instance-priority MEDIUM \
  --worker-group default
```

## 15. 上线 / 下线定时

上线：

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country cn \
  --action online_schedule \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 158514956085248 \
  --workflow-code 158515019593728
```

下线：

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country cn \
  --action offline_schedule \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 158514956085248 \
  --workflow-code 158515019593728
```

## 15. 精确下线单个任务

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country mx \
  --action disable_task \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 13068695921632 \
  --workflow-code 17480254697952 \
  --task-name "ods_msgsvr_ivr_account"
```

## 16. 下线任务前的安全检查建议

对于同步类工作流，在执行以下动作前：

- `disable_task`
- `disable_tasks_except`
- `delete_task`
- `append_task`

建议先查询工作流详情，确认工作流级参数没有被清空：

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler" \
  --country mx \
  --action dump_workflow_graph \
  --ds-token "YOUR_DS_TOKEN" \
  --project-code 13068695921632 \
  --workflow-code 20515301105637
```

人工检查重点：

- `raw_workflow_detail.workflowDefinition.globalParams`
- `raw_workflow_detail.workflowDefinition.globalParamList`

如果这里已经是 `[]`，但任务脚本仍然包含：

- `${src}`
- `${db}`
- `${dt}`
- `${full}`

则不要继续修改工作流定义，先恢复历史版本参数。
