# 数据层规范

## 1. 三条全局表规则（`server/SCHEMA.md`）

**① 跨层不建外键。** 6 个服务独立部署、独立发版，外键会把 DDL 变更耦合死 —— 改 `zt_resource_account` 要停 `zt_task_instance` 的写入。层内可以建，跨层一律靠业务键关联，由应用层保证。

**② 跨层引用一律用业务键，不用自增 id。** `account_id` / `device_id` / `task_id` / `template_id` / `proxy_id` 都是字符串业务键。自增 `id` 只在层内用 —— 将来任一层换库或分库，自增 id 立刻失去意义，业务键不会。

**③ 每张表带 `biz_line`。** 业务线是横切维度，**所有索引都以它打头**。

另有一条只对任务实例成立：**运行时快照必须冻结版本号。** `zt_task_instance` 存 `template_version` / `strategy_version` / `decision_id`，而不是只存 ID —— 归因要能回答「这条任务当时用的是哪一版模板、哪一版策略」，模板改过之后再去 join 当前版本，得到的结论是错的。

推论：**各层只写自己前缀的表。** 6 个服务连同一个库，跨层写没有分布式事务。要改别的层的数据，调对方接口。

## 2. 表命名

```
zt_{层前缀}_{实体}[_{子实体}]
```

| 层 | 前缀 | 现有表 |
|---|---|---|
| 0 | `zt_bizline_` | `def`, `capability` |
| 1 | `zt_resource_` | `account`, `device`, `device_param`, `param_template`, `param_template_field`, `proxy`, `binding`, `contact`, `contact_ref` |
| 2 | `zt_task_` | `command_def`, `command_surface`, `template`, `template_step`, `template_slot`, `instance`, `step`, `guard_log`, `interrupt`, `rate_window` |
| 3 | `zt_risk_` | `weight`, `grade_rule`, `exec_score`, `health_score`, `health_history`, `gate_rule`, `gate_log`, `quota_usage`, `survival`, `survival_batch`, `attribution`, `attribution_case`, `calibration`, `attr_account`, `attr_evidence`, `attr_factor`, `attr_prompt`, `attr_report` |
| 4 | `zt_strategy_` | `def`, `version`, `day_plan`, `ops_rule` |
| 5 | `zt_aisched_` | `agent`, `agent_binding`, `scene`, `decision`, `slot_output` |
| 6 | `zt_orch_` | `timeline`, `timeline_node`, `run`, `run_node`, `review`, `remote_log` |

实体名**单数**。前缀就是层归属的唯一判据 —— 看到一个表名就知道该由哪个 service 写。

新增表前先读 `server/SCHEMA.md` 对应层的小节，字段来源是 `demo/auto_prototype/` 的原型页面与 console 路由，**每张表都能指到具体页面上的哪一列**。新表也要能。

## 3. Entity 规范

放在 `service/{domain}/internal/repository/model.go`：

```go
// Package repository 只能被 service/resource 目录树引用（Go internal 规则）。
// 绑定表的写入口全在这里，因此「资源绑定单写」是编译期事实而非约定。
package repository

// ResourceDevice 设备池。对应 device-pool.html 的列表列。
type ResourceDevice struct {
	Id       int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine  string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_res_device,priority:1;index:idx_res_device_sched,priority:1" description:"业务线"`
	DeviceID string `gorm:"column:device_id;type:varchar(128);uniqueIndex:uk_res_device,priority:2" description:"设备业务键 如 CP-096"`
	Kind     string `gorm:"column:kind;type:varchar(16);index:idx_res_device_sched,priority:2" description:"cloud 云机 / real 真机 / browser 浏览器"`

	Status          string     `gorm:"column:status;type:varchar(16);index:idx_res_device_sched,priority:3" description:"online/busy/idle/offline"`
	Concurrency     int        `gorm:"column:concurrency" description:"可用并发"`
	LastHeartbeatAt *time.Time `gorm:"column:last_heartbeat_at;type:timestamp;null" description:"最近心跳"`
}

func (r *ResourceDevice) TableName() string { return "zt_resource_device" }
func (r *ResourceDevice) Init()             {}
```

必须做到：

- **结构体名 = 表名去掉 `zt_` 后转大驼峰**：`zt_resource_device` → `ResourceDevice`，`zt_task_template_step` → `TaskTemplateStep`。
- **实现 `common/middleware/db.Entity`**：`TableName() string` + `Init()`（`Init` 目前都是空实现，留给将来的默认值填充）。方法接收者用指针。
- **每个字段显式写 `column:`**，不依赖 GORM 的默认命名推导。
- **每个字段带 `description:` 中文说明**，写清枚举取值（`"cloud 云机 / real 真机 / browser 浏览器"`）和业务含义。这份说明是给人看的唯一文档。
- **`type:` 显式声明长度**：业务键 `varchar(64)`~`varchar(128)`，枚举 `varchar(16)`，业务线 `varchar(32)`，等级 `varchar(2)`，比率/分数 `decimal(5,2)`。
- **可空时间用 `*time.Time` + `type:timestamp;null`**。
- 主键固定 `Id int64`（注意是 `Id` 不是 `ID`，与项目现状一致），业务键字段名用 `XxxID`。

### 索引

```go
// 唯一键：业务线 + 业务键
BizLine  string `gorm:"...;uniqueIndex:uk_res_device,priority:1"`
DeviceID string `gorm:"...;uniqueIndex:uk_res_device,priority:2"`

// 列表/调度复合索引：biz_line 打头，后面按筛选频次排
BizLine string `gorm:"...;index:idx_res_device_sched,priority:1"`
Kind    string `gorm:"...;index:idx_res_device_sched,priority:2"`
Status  string `gorm:"...;index:idx_res_device_sched,priority:3"`
```

命名：`uk_{层缩写}_{实体}` / `idx_{层缩写}_{实体}_{用途}`（缩写如 `res` / `task` / `risk` / `orch`）。
**`priority:1` 永远是 `biz_line`。** 前端每个请求都带 `bizLine`，不打头的索引等于没建。

### 快照冗余列要标注权威源

```go
// 以下三列是 risk 层回写的只读冗余，仅供列表排序筛选。
// 任何判断逻辑（准入、门禁）必须读 risk，不得读这里。
HealthScoreCache float64    `gorm:"column:health_score_cache;type:decimal(5,2);index:idx_res_account_list,priority:4" description:"健康分快照，权威源在 risk 层"`
GradeCache       string     `gorm:"column:grade_cache;type:varchar(2)" description:"等级快照，权威源在 risk 层"`
ScoreSyncedAt    *time.Time `gorm:"column:score_synced_at;type:timestamp;null" description:"快照同步时点"`
```

**跨层回写的冗余列一律带 `Cache` 后缀 + 注释写明权威源。** 少了这个标注，半年后有人拿它做门禁判断，而它可能已经过期几小时。

## 4. Repository 规范

`service/{domain}/internal/repository/repository.go`，**一个域一个 Repository 结构体**：

```go
type ResourceRepository struct {
	db.Repository[*ResourceBinding]   // 嵌入泛型仓储，拿到 .Db 和 .SetDb
}
```

嵌入的泛型参数选**本域最核心的那张表**（resource 选 `*ResourceBinding`，因为绑定是它的单写职责），其余表通过 `r.Db.Model(&XxxEntity{})` 访问 —— 泛型参数在这里主要是拿 `Db` 字段和 `SetDb` 方法，不是限制。

方法写法：

```go
// 内部 Query 结构体，与 dto.XxxQuery 分开：这里的字段已经是 string/int，
// 不带 contract.BizLine 这类领域类型，Repository 不认领域概念。
type AccountQuery struct {
	BizLine string
	Stage   string
	Keyword string
	Offset  int
	Limit   int
}

func (r *ResourceRepository) ListAccounts(ctx context.Context, q AccountQuery) ([]*ResourceAccount, int64, error) {
	tx := r.Db.WithContext(ctx).Model(&ResourceAccount{}).Where("biz_line = ?", q.BizLine)
	if q.Stage != "" {
		tx = tx.Where("stage = ?", q.Stage)
	}
	if q.Keyword != "" {
		tx = tx.Where("phone LIKE ?", "%"+q.Keyword+"%")
	}

	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if q.Limit > 0 {
		tx = tx.Offset(q.Offset).Limit(q.Limit)
	}

	var rows []*ResourceAccount
	err := tx.Order("last_active_at desc").Find(&rows).Error
	return rows, total, err
}
```

规则：

- **每个方法第一个参数是 `ctx`，一律 `r.Db.WithContext(ctx)`。**
- **`biz_line = ?` 是每个查询的第一个 Where。** 漏了就是跨业务线数据泄露。
- 列表方法返回 `(rows, total, error)`，先 `Count` 再 `Offset/Limit`。
- `NotFound` 统一翻译成哨兵错误，不把 GORM 错误漏给上层：

```go
if err == gorm.ErrRecordNotFound {
	return nil, contract.ErrNotFound
}
```

- **Repository 不做业务判断。** 只有查询条件拼装和 SQL，不写 if 业务规则。
- 返回 Entity 指针切片，转 View 是 Service 的事。

### Upsert 与状态迁移

项目里 `SaveXxx` 是 upsert 语义（前端只有一个「保存」）：

```go
func (r *ResourceRepository) UpsertAccount(ctx context.Context, row *ResourceAccount) error {
	var existing ResourceAccount
	err := r.Db.WithContext(ctx).
		Where("biz_line = ? AND account_id = ?", row.BizLine, row.AccountID).First(&existing).Error
	if err == gorm.ErrRecordNotFound {
		return r.Db.WithContext(ctx).Create(row).Error
	}
	if err != nil {
		return err
	}
	row.Id = existing.Id
	return r.Db.WithContext(ctx).Model(&existing).Updates(row).Error
}
```

状态机迁移要**同时落时点**：

```go
// MoveStage 状态机迁移。stage_changed_at 一并落，归因要看停留时长。
func (r *ResourceRepository) MoveStage(ctx context.Context, bizLine, accountID, stage string) error {
	return r.Db.WithContext(ctx).Model(&ResourceAccount{}).
		Where("biz_line = ? AND account_id = ?", bizLine, accountID).
		Updates(map[string]any{"stage": stage, "stage_changed_at": time.Now()}).Error
}
```

用 `Updates(map[string]any{...})` 而不是结构体 —— 结构体会跳过零值字段。

## 5. 全局 DB 与仓储缓存

`common/middleware/db` 提供两套东西：

```go
// 显式注入（领域包用这个）
repo := &repository.ResourceRepository{}
repo.SetDb(database)

// 全局单例缓存（httpx.Boot 里 db.SetDatabase(database) 存进去）
db.Database()             // 取全局 *gorm.DB
db.GetRepository[R]()     // 取/建 R 的单例，自动调 SetDb
```

**新代码走显式注入。** 全局缓存是过渡设施，`SetDatabase` 会清空整个仓储缓存，多进程/多库场景下不安全。

## 6. 连接配置

`httpx.Boot` 里的 GORM 配置：

```go
gorm.Open(mysql.Open(dsn), &gorm.Config{
	DisableForeignKeyConstraintWhenMigrating: true,   // 呼应「跨层不建外键」
	Logger: logger.Default.LogMode(logger.Error),     // 只打错误
})
```

DSN 来自 `configs/application.properties` 的 `sqlconn` 键。

**目前没有配连接池**（`MaxOpenConns` / `MaxIdleConns` / `ConnMaxLifetime` 都是 Go 默认值），没有慢查询日志，没有 AutoMigrate 调用 —— 表结构靠 `SCHEMA.md` 手工维护。这几项是已知缺口，独立部署前需要补。

## 7. 加一张表的清单

- [ ] 表名 `zt_{层前缀}_{实体}`，前缀与要写它的 service 一致
- [ ] 在 `server/SCHEMA.md` 对应层小节补一节，字段能指到原型页面/console 的哪一列
- [ ] Entity 放 `service/{domain}/internal/repository/model.go`，实现 `TableName()` + `Init()`
- [ ] 每字段 `column:` + `type:` + `description:`（枚举写全取值）
- [ ] `biz_line varchar(32)` 必有；唯一键 `uk_*` 与列表索引 `idx_*` 都以 `biz_line` `priority:1`
- [ ] 可空时间 `*time.Time` + `type:timestamp;null`
- [ ] 跨层引用只放业务键字符串，不放别层的自增 id，不建跨层外键
- [ ] 跨层回写的冗余列带 `Cache` 后缀 + 注释标权威源
- [ ] Repository 方法：`ctx` 首参、`WithContext`、`biz_line = ?` 首个 Where、`ErrRecordNotFound` → `contract.ErrNotFound`
- [ ] 手工执行 DDL 后确认 `SCHEMA.md` 与库一致
