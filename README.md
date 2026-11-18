# 网上南宁 0.8.2 本地地图

这是基于网上南宁 0.8.2 底图的本地查看器，也是创意工坊模型的预览环境。克隆后可以直接启动地图。三维模式需要 WebGL 2。

```sh
git clone https://github.com/ziyan2006/nnol-map-workshop.git
cd nnol-map-workshop
python serve.py --open
```

默认地址为 [本地地图](http://127.0.0.1:8788/)，也可以打开 [底图对照](http://127.0.0.1:8788/?replacements=off)。端口已占用时，用 `--port 8790` 指定其他端口。

用下面的命令检查并预览投稿 ZIP。把示例 ZIP 路径换成自己的交付包路径。图片附件的完整性检查使用 Pillow。

```sh
python -m pip install Pillow
python submission.py submissions/nn14-jianzheng-1.0.0.zip
python serve.py --port 8789 --submission submissions/nn14-jianzheng-1.0.0.zip --open
```

预览服务会输出三维和街景直达链接。[投稿包协议](MODEL-REPLACEMENT.md)与 [Agent 投稿 Prompt](MODEL-SUBMISSION-PROMPT.md)提供完整流程。

## 投稿站与审核后台原型

```sh
python -m pip install Pillow
python workshop.py --open
```

- [演示登录](http://127.0.0.1:8791/workshop/login)提供两个玩家账号和两个审核账号，供本机体验认领与竞态。
- 玩家登录进入[模型投稿](http://127.0.0.1:8791/workshop/)，可地图选点、复制地点资料和 Prompt、上传 ZIP。在[我的投稿](http://127.0.0.1:8791/workshop/account)查看自己的审核进度、意见和候选模型。
- 开发者登录进入[审核工单](http://127.0.0.1:8791/workshop/review)。队列和详情显示当前生命周期标签。Agent 先保存初审意见，随后审核员认领并复核。退修后，玩家可在「我的投稿」把新版提交到同一工单。接受后的工单进入「待移植」，开发者完成验证后记录移植完成。
- 投稿、附件、会话和审核记录保存在本地 `.workshop/submissions.sqlite3`。用 `--storage` 指定其他数据目录。加入账号功能前的历史投稿继续显示在审核队列。

选点与本地地图共用 0.8.2 大地图的地点分类、地标和公开客户端补充点位。补充点位及来源见 `data/map-search-pois.json`。使用 `/` 聚焦搜索，方向键和回车选择地点。工坊样式以游戏入口页为参考，标题使用其 Barlow 字体子集，许可见 `workshop_ui/barlow-OFL.txt`。

首次打开投稿页会显示交互教程。点击导航栏的「教程」可重看，教程内可以试搜地点、查看 Prompt、选用示例包和打开投稿状态查询。

原型只在本机回环地址运行。正式发布仍通过模型替换发布清单处理。

账号接入点见 [页游账号对接说明](WORKSHOP-AUTH.md)。
审核后台可通过「MCP 接入」配置本机 Agent，让它读取工单、保存审核建议、导出待移植交付包，并在移植验证后登记完成。[工坊 MCP 使用说明](WORKSHOP-MCP.md)

演示路线：玩家选用十四中示例包 → Agent 初审 → 开发者认领并退修 → 玩家在原工单选用修订演示包 → Agent 再次初审 → 人工复核。修订演示包补了一段文字说明，沿用原模型，便于核对版次链。

也可在「我的投稿」演示撤回，或在审核后台的「待移植」工单登记和解除移植阻塞。

- **二维地图**支持拖动、滚轮缩放、搜索地标和查看游戏坐标。点击地图空白处选点，再点击「传送到此处」，即可在该坐标进入街景。右键可在地标上精确选点，地图获得焦点时按 Enter 可选择中心点。地标有原版入口数据时，可以在地标位置和入口间切换。
- **三维地形**使用同一套坐标。左键旋转视角、右键平移、滚轮缩放。侧栏可切换道路、地标和远景建筑。
- **青秀山**可以从上方的快捷按钮直接切换到天池或龙象塔，再查看原版标注入口。
- **全城街景**可从二维地图中心、三维地形中心或地标进入。W A S D 或方向键移动，左键拖动转头，Shift 加速。用 24 小时时间滑块调整天空、光照和亮灯程度。点击顶部按钮直接查看 [桂雅路截图位置](http://127.0.0.1:8788/?view=street)，也可用街景里的“回到截图坐标”返回。
- **飞行和小地图**按 F 或点击「飞行」切换。飞行时 W A S D 平移，空格上升，Shift 下降，滚轮向上加速、向下减速。小地图固定朝北，箭头指向当前视角，点击小地图可打开当前位置的二维地图。
- **原版精细模型**选中有独立模型的地标后，点击“查看原版模型”。可直接打开 [龙象塔](http://127.0.0.1:8788/?view=model&id=longxiang) 或 [南宁东站](http://127.0.0.1:8788/?view=model&id=nanning-east)。

## 覆盖范围

地图覆盖原版南宁城区的约 30.8 × 24.5 公里范围。二维底图使用原始道路折线、水面、公园、林地和立交数据，地标取自城市索引。三维地形使用原版 20 米高程网格，以约 50 米采样构建显示网格，建筑采用原版城市远景模型。这个视图把道路和水面画在高程网格上，桥面、台阶及地形垫块的精细高差需要用游戏内近景验证。

全城街景覆盖城市索引的 806 个分块。桂雅路周围四个分块有预生成网格，其余位置使用同一版本的原版 `near` 分块生成器，按位置请求道路、建筑、树木和铺装数据。未缓存的分块首次需要联网，下载的源数据会缓存在本机。浏览器只保留附近分块。桂雅路初始机位为 **22.8051° N，108.3919° E**，朝向按参考画面中的楼体和路缘对齐。

原版独立模型清单里的 17 套 GLB 全模、预览和配套 JSON 已全部保存到本地。靠近时加载全模，距离较远时使用原版预览。模型用游戏中的 X、Z、基准高程字段和朝向摆放，查看器使用自己的日夜照明和相机。游戏单独编写的程序化地标、模型接地修补、室内及交互组件需要游戏运行时。

## 数据所在文件

| 文件 | 内容 |
| --- | --- |
| `data/index.json` | 城市范围、地标、入口、出生点，X / Z 以米计 |
| `data/overview.json` | 道路和水面等图层。绘制道路优先读 `mapRoads`，立交另读 `viaducts` |
| `data/terrain.json`、`data/terrain.png` | 高程网格的描述与编码图，X 向东、Z 向南 |
| `data/hlod.json`、`data/hlod.bin` | 远景建筑分块索引与网格 |
| `data/street/` | 桂雅路街景网格。各分块的 `.json` 描述缓冲区名称、偏移、元素数和数组类型，与 `.bin.gz` 配对 |
| `data/street/textures/` | 原版立面、地面、树叶材质与游戏生成的店招图集 |
| `data/landmarks/index.json` | 独立地标 ID 与哈希资源清单，GLB 和配套 JSON 在同一目录 |
| `data/city-source/` | 原版分块及建筑分类、道路、围合、沿江等数据的本地缓存 |
| `map.js`、`terrain.js` | 二维底图和三维预览的绘制代码 |
| `street.js`、`street-materials.js` | 街景相机、网格加载与昼夜材质 |
| `street-tiles.js`、`landmarks.js` | 街景分块生成调度，以及近远地标模型加载 |

公开资源来自[网上南宁 0.8.2 的城市资源](https://nanningol.com/city/index.json)、[客户端近景生成器](https://nanningol.com/assets/tile.worker-DaS-Frwj.js)及[地标资源清单](https://nanningol.com/assets/PrefetchPolicy-qFff3YmY.js)，城市索引修订号为 `c68fddd3c1591787`。原始数据来源包括 [OpenStreetMap](https://www.openstreetmap.org/copyright)、3D-GloBFP（Che et al., 2024，CC BY 4.0）和 Mapzen Terrain Tiles（SRTM）。Three.js 库和 MIT 许可随 `vendor/` 提供。
