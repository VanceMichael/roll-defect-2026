# 领料核查能力（capability）

接在质检与装车台两边常用领料核查里的 Node.js 能力：从现场扫描凭据一路核到本次真要装车的用幅。
作为库引入（`capability/index.mjs`）或直接运行 HTTP 服务：

```sh
npm run capability   # 默认 127.0.0.1:8710，PORT / SOURCE_ROOT / PROVIDER_ROOT 可调
```

## 数据汇合与判定口径

- **谱系（cuts）**：成品卷纵段 → 母卷纵横区间，方向 `+/-` 只影响纵向换算；横向一律按「成品横向零 = 该段横向裁切起点」折算。拼接、反向上卷、裁边后，同一横线在不同纵段指向不同母卷。
- **区块凭据（scanline）**：只有完整且哈希匹配的区块覆盖其索引范围；零缺陷的完整块同样提供覆盖。重扫沿用条带名，按（扫描代、母卷、区块）定位：取回上一代读数判 `stale`，哈希对不上判 `hash-mismatch`，旧读数不充当新标定。
- **缺陷（holes）**：以当前资料版的复判接受位为准，两个维度均有正长度相交才扣这一单；超出本次用幅的孔洞列入 `outOfScope`，不扣；未复判的列入 `pendingReview`。
- **覆盖缺失 ≠ 已确认缺陷**：缺口按原因区分 `window-incomplete`（检窗口未完成）、`credential-stale` / `credential-invalid` / `credential-missing`（凭据问题）、`no-credential`。
- **装车台**：`labels` 回执是在车状态唯一依据。隔离只隔相交段；`202` 仅表示接收，回读到 `held` 前车位不重新分配；已装出的留原标签，报截回或继续追踪区间。多块领料单共用的原检区块在 `sharedWith` 标出，仍可留用。

## 库接口（Capability）

| 方法 | 用途 |
| --- | --- |
| `refresh()` | 拉齐两侧资料，返回资料版与相对上一快照的变化（复检更正、扫描代更替、覆盖得失、回执变化） |
| `assessOrder(order)` | 单张领料单核查：应领区块、缺口、扣单缺陷、界外孔、处置与入车门禁 |
| `assessRange(finished, {y0,y1,u0,u1})` | 任意双轴范围核查（「同一成品卷的另一段能不能先发」） |
| `plan()` | 全部领料单处置：`clear` / `await-evidence` / `isolate-required` / `isolated` / `recall` / `departed-clear` |
| `reconcile({autoHold})` | 对需隔离的未出库标签提交隔离（只隔相交段），返回回执、最新计划与车位 |
| `dockReport()` | 标签、各车位可否重新分配、各单能否继续扫描入车 |
| `supervisor(finished)` | 主管查询：母卷证据、补扫缺口、真实在车状态、需处置的用幅、截回区间、两侧互查差异 |

## HTTP 接口

| 端点 | 说明 |
| --- | --- |
| `POST /refresh` | 同 `refresh()` |
| `GET /requisitions` / `GET /requisitions/:order` | 全部 / 单张领料单核查 |
| `POST /requisitions/check` | `{finished, y:[起,止], u:[左,右]}` 任意范围核查 |
| `POST /reconcile` | `{autoHold}` 提交隔离并返回计划与车位 |
| `GET /dock` | 装车台视角：标签、车位、入车门禁 |
| `GET /supervisor/rolls/:finished` | 主管查询 |

## 演练

`npm run source` 与 `npm run provider` 起两侧模拟器后，`npm run capability` 即可对接。
`POST /control?edition=r2`（来源）与 `POST /lab?stage=rescan|known`（外部接口）推进复检更正剧情；
`npm test` 中的 `test/capability.test.mjs` 完整走了一遍：初检 → 更正隔离 → 回读放行。
