# 地图模型替换协议 v1

创意工坊的最小发布单位是一个地图目标的一版模型。投稿包记录模型、底图版本、摆放方式和应隐藏的底图建筑范围。开发团队审核完成后，在发布清单里把该目标的 `active` 指向审核通过的版本。二维地图、三维地形和街景共用同一个目标 ID。

## 文件与坐标

| 文件 | 职责 |
| --- | --- |
| `data/replacements/index.json` | 开发团队维护的发布清单。记录 `baseRevision`、目标 ID、显示名称、模型定位点 `point`、街景观察点 `approachAt`、模型高度和当前发布版本 `active`。 |
| `data/replacements/<target>/<version>/manifest.json` | 版本清单。记录 `schemaVersion: 1`、`target`、`version`、`baseRevision`、`placement`、`scope`、`asset` 和 `source`。模型、摆放或范围有变化时发新版本。 |
| `data/replacements/<target>/<version>/model.glb` | 自包含的 GLB 2.0，以米为单位，Y 轴向上。贴图和缓冲内嵌。当前加载器限制为 20 MiB，并校验清单声明的长度和 SHA-256。 |

- `point`、`approachAt` 和 `scope` 顶点使用当前底图的世界坐标 `[x, z]`，单位为米，X 向东，Z 向南。底图原点在 `data/index.json` 的 `origin`。提交经纬度素材时，先换算到该底图坐标系。
- `placement.anchor` 为 `[x, z, 地表高程偏移]`，水平分量与目标的 `point` 一致。`yaw` 为绕 +Y 的旋转角，单位为度，+90° 将模型的 +Z 朝向转到地图东侧。`scale` 为统一缩放倍率。
- `scope` 是原建筑的闭合多边形列表，每个多边形首尾自动闭合。三维地形以原远景楼块的中心点归属范围，街景以原建筑网格的三角形中心归属范围。审核时按应隐藏的原建筑描范围，并与其他已发布目标核对。跨地块的楼块或网格会影响边界效果，需要分别在两个视图复核。
- `source` 记录作者及来源。有版本库的作品可填写 `repository` 和 40 位 `commit`。手工导出的作品可填写 `kind: "original"` 或 `"adapted"`，并在 `description` 说明原作或改编来源。

## 创意工坊交付 ZIP v1

一个 ZIP 对应一个地图目标的一个版本，三个必需文件直接放在 ZIP 根目录。现有发布目录继续使用模型和版本清单。

```text
manifest.json             必需，模型版本清单
model.glb                 必需，自包含的 GLB 2.0 模型
submission.json           必需，审核与预览登记
changes.md                可选，具体改动说明
evidence/
  real-world/             可选，实景参考图
    gate.jpg
    facade.jpg
  model/                  可选，独立模型图
    overview.png
  in-map/                 可选，导入地图后的验证图
    street.png
    aerial.png
```

`submission.json` 的结构如下。新目标的地图坐标直接取自 `placement.anchor` 的前两个分量。已有目标的锚点须与当前发布清单登记的位置一致。

```json
{
  "schemaVersion": 1,
  "place": {
    "name": "南宁市第十四中学（建政校区）",
    "description": "青秀区建政路27号 · 教学综合楼",
    "approachAt": [-5101, -1667],
    "height": 30.25
  },
  "rights": {
    "basis": "permission",
    "statement": "填写作者、素材来源和实际允许的使用范围。"
  }
}
```

### 硬性预校验

- ZIP 本身及展开后的内容均不得超过 48 MiB。三类图片按解压后的文件字节数合计不得超过 24 MiB。每个清单上限 64 KiB。禁止重复路径、越界路径、符号链接和加密文件。
- 两份清单使用 UTF-8 JSON，`schemaVersion` 均为 `1`。目标 ID、三段式版本、当前底图版本、锚点、朝向、缩放、旧建筑范围和来源必须有效。修改已登记的模型版本时，使用新版本号。替换范围的多边形须无自交或重复顶点。
- 地点名称、模型高度、可进入街景的观察点和授权声明必填。`description` 可省略。`rights.basis` 取 `original`、`permission` 或 `license`，`statement` 按实际情况填写。
- GLB 不超过 20 MiB。预校验检查字节数和 SHA-256、自包含的二进制结构、贴图引用及网格是否存在。当前地图未启用 Draco 和 KTX2 解码。视觉效果和实际渲染仍需打开预览验证。

硬性校验失败的包直接退回，返回错误码和原因，可修正后重交。通过的包进入待审核队列，包括没有附加材料的包。

### 可选材料与排队

| 材料 | 建议内容 | 分值 |
| --- | --- | --- |
| `evidence/real-world` | 与落位相关的实景照片，附来源和使用范围 | 1 |
| `evidence/model` | 清楚展示几何和材质的独立模型图 | 1 |
| `evidence/in-map` | 使用新模型的三维或街景截图，便于看位置、比例与周边衔接 | 1 |
| `changes.md` | 明确写出替换了哪些旧楼、新增或修改了什么、配准依据和已知偏差 | 1 |

每类均可附多张图，支持 `.png`、`.jpg` 和 `.jpeg`。数量不限，三类图片共用 24 MiB 配额，超过配额会退回整个 ZIP。每类有至少一张可读图片就得 1 分。损坏的图片会提示具体文件名，同类其他可读图片仍可计分。旧的单图路径如 `evidence/model.png` 仍可读取。说明采用 UTF-8 Markdown，上限 64 KiB。图片的来源可记录在授权声明或交付说明里。真实性、实际内容和授权由审核人核对。

待审队列按分数从高到低排列，同分按进入队列的时间从早到晚。后台应显示四项得分、格式警告、底图版本、待审模型和底图的对照入口。审核动作可记录为通过、退修或拒绝，发布仍由开发团队更新 `active`。

### 投稿网站的流程

1. 投稿者先在二维地图选已有目标或标记新地块。页面生成可复制的「地点资料」，包含显示名称、目标 ID、底图版本、世界坐标、街景观察点和可用的底图参考。新地块的目标 ID 由页面分配。
2. 投稿指导区提供十四中示例包、可直接复制的 Agent Prompt 和必需文件检查表。投稿者把地点资料和自己的参考素材附给 Agent。可选材料在独立区域说明，显示各类图片的用途和共享配额。
3. 上传后，页面直接显示退回原因或分项得分。退回的包可以更正并重传，通过的包显示待审核状态。
4. 开发者在后台按队列顺序打开候选版，与底图比较后记录审核结论。审核记录关联同一份 ZIP 的摘要，实际发布使用对应版本的模型和清单。

### 本地检查与预览

```powershell
python submission.py .\submissions\nn14-jianzheng-1.0.0.zip
python serve.py --port 8789 --submission .\submissions\nn14-jianzheng-1.0.0.zip --open
```

校验命令输出 JSON，包括 `passed`、`reviewScore` 和逐项附件结果。校验失败时退出码为 1。安装 Pillow 后可验证并计分图片附件，命令为 `python -m pip install Pillow`。预览服务复用同一校验器，将通过校验的包临时载入本机地图，并输出三维与街景的直达链接。开发团队可在该服务里审核新目标，发布清单文件无需改动。

投稿者可以把 [Agent 投稿 Prompt](MODEL-SUBMISSION-PROMPT.md) 交给自己的建模助手，从参考资料整理走到导出 ZIP 与预校验。

## 提交、审核与回滚

1. 投稿者提交 ZIP。校验通过后，审核人从预览核对目标、底图版本、旧建筑范围与街景观察点。
2. 在固定机位对照三维地形和街景。确认位置、朝向、屋顶高度、相邻建筑、道路边界和渲染性能，检查新模型加载时旧建筑正确消失。
3. 发布时先部署版本目录，再更新发布清单的 `active`。客户端校验底图版本、资产长度和哈希，成功解码并放置模型后才隐藏范围内的原建筑。模型加载失败、地区离开加载范围时，原建筑继续显示或恢复显示。
4. 回滚时把 `active` 指回上一版，或设为 `null` 恢复底图。刷新页面后生效。对照链接的 `replacements=off` 在当前页面关闭所有替换，保留目标和固定观察机位。

本地原型通过文件模拟审核后的发布。渲染替换覆盖街景建筑和三维远景楼块，街道、地面、植被和既有的街景移动仍使用当前底图。高模沿用精细地标的按需加载策略，远距离显示原远景。

## 十四中建政校区试件

目标 ID 为 `nn14-jianzheng`，替换版本为 `1.0.0`。GLB 从源仓库提交 `ebbae01093fee6b821e7ebcbbe887fd8c71a081c` 的 `buildSchool` 导出，包含教学楼、楼层构件、屋顶跑道和标牌。源演示场景的街区和地台由本地底图承接。模型约 13.9 MB，近似占地 48.4 × 47.3 米。

建政路 27 号的地点依据项目地址和高德 POI 交叉确认。将 POI 坐标换算到底图并沿建政路对齐后，采用锚点 `[-5062, -1619.2]` 和 `-141°` 作为本地试放。范围按底图地块内重叠的近景建筑轮廓绘制。位置、高程、朝向和遮罩均为近似配准。原来位于竹塘的地标使用独立 ID。

- [三维模型](http://127.0.0.1:8788/?view=model&id=nn14-jianzheng) · [三维底图对照](http://127.0.0.1:8788/?view=model&id=nn14-jianzheng&replacements=off)
- [街景模型](http://127.0.0.1:8788/?view=street&id=nn14-jianzheng) · [街景底图对照](http://127.0.0.1:8788/?view=street&id=nn14-jianzheng&replacements=off)
- [模型源仓库](https://github.com/ziyan2006/nanning-14-voxel-campus) · [建政校区项目地址](https://gx.people.com.cn/n2/2025/1022/c390645-41387800.html) · [高德建政校区 POI](https://ditu.amap.com/place/B030302MMF)
