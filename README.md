# 跨赛区球队名单锁定与争议赛果发布

本仓库保存该业务的合成登记资料、身份核验登记处的本地协议服务，以及业务应用服务。所有机构、人员、金额和文书均为虚构，不连接真实业务系统。

## 运行环境

使用 Node.js 22.23.4。没有第三方 npm 依赖，package-lock.json 锁定当前依赖清单。

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run demo          # 端到端本地演练（内存态，不写盘）
npm run start:app     # 业务服务，默认 4318 端口
npm run start:partner # 身份核验登记处替身，默认 4317 端口
```

业务服务环境变量：PORT 更换端口，APP_STATE 指定持久状态文件（默认 .local/app.json，停止后用同一文件重启会保留业务状态），PARTNER_URL 指向身份核验登记处后可通过业务接口发起材料核对。首次启动时若状态文件不存在，会把 fixtures/records.json 的登记资料装入：报名均为待审核，refereeDrafts 与 sourceChanges 进入收件箱（GET /inbox），不自动变成已批准决定。

也可以使用 Docker 启动业务服务：

```bash
docker build -t village-football:local .
docker run --rm -p 4318:4318 village-football:local
# 需要合作方替身时：docker run --rm -p 4317:4317 village-football:local npm run start:partner
```

容器要保留状态时，将可写目录挂载到 /app/.local；该目录需允许容器 node 用户写入。测试使用临时目录与随机本地端口，可独立运行。

## 业务边界

地方赛区与总决赛共用这一套服务。一张报名表不等于每场比赛的可上场名单；名单被接收、比赛获准开赛、晋级被正式确认是三件不同的事，接口分别可见：

- 名单被接收：PUT /matches/:id/rosters/:team 后 POST .../submit，返回 receivedAt；接收只做浅校验。
- 比赛获准开赛：POST /matches/:id/start 由裁判确认，此时才判定资格与未消化处罚并锁定名单；被阻断时返回 409 与逐条原因（GET /matches/:id/readiness 可先查）。
- 晋级被正式确认：赛果公示满 appealMinutes 且无未结申诉或争议后自动确认（也可 POST /matches/:id/advancement/confirm 触发判定），确认后胜者才填入下游席位。

主要规则：球员以稳定编号关联各赛区记录，不按姓名合并；一个赛季只能代表一支仍有效的球队；转队要原队释放且新队所属赛区审核通过，释放不抹旧队出场事实，停赛随球员走。停赛（单场两黄、直接红牌、累计黄牌阈值，均按赛事配置）只由之后实际开赛的本队比赛消化，轮空与取消场次不算。纪律决定可能晚于名单提交，提交成功不等于能开赛。赛区撤销或更正资格证明时，只把名单锁定时证明已无效的比赛送入争议，不简单重算历史赛果。裁判更正处罚须经赛事复核并说明影响，已开始比赛的名单不删改，可能影响的已赛比赛进入争议。两名裁判同时录入同一事实（同人、同种、同分钟）不重复累计。申诉在公示后配置时限内由参赛队务发起，受理后相关晋级席位处于争议中；下一轮已开赛时上轮裁决变更不静默替换球队、不撤掉已发生的出场和处罚，而是停止受影响分叉的自动推进，等待组织者作出有原因的处置。公示结果区分场上比分、裁定结果及当前能否用于晋级（GET /matches/:id/result）。资料申请人不能批准自己的资格或纠正；队务只能改本队名单；赛区审核人不能跨赛区处理材料。

操作人经 X-Actor-Id 请求头识别，角色见 fixtures 的 actors（team/region/referee/competition）；组织者可用 POST /actors 签发新操作人。POST /control/clock 可冻结演练时钟（DELETE 恢复真实时间），便于排练跨日流程。按球员、比赛或争议查回决定依据：GET /players/:id/record、GET /matches/:id/record、GET /disputes/:id，全部状态变化另有 GET /audit 流水。GET / 返回接口清单。

## 资料

fixtures/records.json 是业务原始资料，sourceChanges 保存后续收到的变更或申请，均没有自动导入成已批准决定。fixtures/relations.json 声明登记资料的关联字段，docs/data.md 解释计量和身份语义。fixtures/partner.json 定义合作方接口名称及字段。support/peer.mjs 提供合作方行为，docs/partner.md 是实际协议；注册核验方只回答身份材料状态，不负责决定当场名单和晋级。src/ 是业务服务（store 持久化、seed 装资料、domain 业务规则、server 接口），app.mjs 是入口，scripts/demo.mjs 是端到端演练，tests 检查协议、资料关系和业务规则。
